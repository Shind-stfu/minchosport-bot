package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/socket"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestBuildHistoryRequestUsesUnixSeconds(t *testing.T) {
	const timestampSeconds int64 = 1_700_000_000
	request, err := BuildHistoryRequest(nil, "120363000000000000@g.us", "message-anchor", timestampSeconds, false)
	if err != nil {
		t.Fatalf("BuildHistoryRequest returned an error: %v", err)
	}
	operation := request.GetProtocolMessage().GetPeerDataOperationRequestMessage()
	history := operation.GetHistorySyncOnDemandRequest()
	if got := history.GetOldestMsgTimestampMS(); got != timestampSeconds {
		t.Fatalf("timestamp sent to WhatsApp = %d, want Unix seconds %d", got, timestampSeconds)
	}
	if got := history.GetOnDemandMsgCount(); got != 50 {
		t.Fatalf("history page size = %d, want 50", got)
	}
	if got := history.GetChatJID(); got != "120363000000000000@g.us" {
		t.Fatalf("chat JID = %q", got)
	}
	if got := history.GetOldestMsgID(); got != "message-anchor" {
		t.Fatalf("message anchor = %q", got)
	}
}

func TestInitialConnectionRetryPolicyOnlyRetriesTransientFailures(t *testing.T) {
	reset := &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}
	if !isRetryableConnectError(reset) {
		t.Fatal("connection reset should be retried")
	}
	if !isRetryableConnectError(socket.ErrDialFailed) {
		t.Fatal("websocket dial failure should be retried")
	}
	if isRetryableConnectError(errors.New("account was logged out")) {
		t.Fatal("permanent account errors must not be retried")
	}
	for _, status := range []int{408, 500, 501, 502, 503, 504} {
		if !isRetryableConnectStatusCode(status) {
			t.Errorf("status %d should be retried", status)
		}
	}
	for _, status := range []int{400, 401, 403, 404} {
		if isRetryableConnectStatusCode(status) {
			t.Errorf("status %d should not be retried", status)
		}
	}
}

func TestMatchHistoryRequestUsesGroupAndOnlyCorrelatesAnUnlabeledResponseWhenUnambiguous(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "request-a", groupID: "first@g.us"},
		{requestID: "request-b", groupID: "second@g.us"},
	}
	if got := bridge.matchHistoryRequest("", []string{"second@g.us"}, nil); got != "request-b" {
		t.Fatalf("matched request = %q, want request-b", got)
	}
	if len(bridge.pendingHistory) != 1 || bridge.pendingHistory[0].requestID != "request-a" {
		t.Fatalf("group matching removed the wrong pending request: %#v", bridge.pendingHistory)
	}
	if got := bridge.matchHistoryRequest("", nil, nil); got != "request-a" {
		t.Fatalf("empty batch matched request = %q, want request-a", got)
	}

	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "request-c", groupID: "first@g.us"},
		{requestID: "request-d", groupID: "second@g.us"},
	}
	if got := bridge.matchHistoryRequest("", []string{"unknown@g.us"}, nil); got != "" {
		t.Fatalf("ambiguous unmatched response was incorrectly assigned to %q", got)
	}
	if len(bridge.pendingHistory) != 2 {
		t.Fatalf("ambiguous response consumed a pending request: %#v", bridge.pendingHistory)
	}
}

func TestMatchHistoryResponseByAnchorAndDiscardRetriesForThatPage(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "page-1", groupID: "supplier@g.us", messageID: "anchor-new", timestampSec: 200},
		{requestID: "page-1-retry", groupID: "supplier@g.us", messageID: "anchor-new", timestampSec: 200},
		{requestID: "page-2", groupID: "supplier@g.us", messageID: "anchor-old", timestampSec: 100},
	}

	latePage := []historyReference{{Key: struct {
		RemoteJID   string `json:"remoteJid"`
		ID          string `json:"id"`
		FromMe      bool   `json:"fromMe"`
		Participant string `json:"participant,omitempty"`
	}{RemoteJID: "supplier@g.us", ID: "message-from-page-1"}, MessageTimestamp: 190}}
	if got := bridge.matchHistoryRequest("", []string{"supplier@g.us"}, latePage); got != "page-1" {
		t.Fatalf("late page response matched %q, want page-1", got)
	}
	if len(bridge.pendingHistory) != 1 || bridge.pendingHistory[0].requestID != "page-2" {
		t.Fatalf("matching page 1 did not discard its retry while preserving page 2: %#v", bridge.pendingHistory)
	}

	pageTwo := []historyReference{{Key: latePage[0].Key, MessageTimestamp: 90}}
	if got := bridge.matchHistoryRequest("", []string{"supplier@g.us"}, pageTwo); got != "page-2" {
		t.Fatalf("page 2 response matched %q, want page-2", got)
	}
	if len(bridge.pendingHistory) != 0 {
		t.Fatalf("matched page remained pending: %#v", bridge.pendingHistory)
	}
}

func TestMatchHistoryResponseByProtocolSessionIDBeforeFallback(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "request-old", protocolID: "protocol-old", groupID: "first@g.us", messageID: "anchor-a", timestampSec: 200},
		{requestID: "request-current", protocolID: "protocol-current", groupID: "second@g.us", messageID: "anchor-b", timestampSec: 100},
	}
	// The protocol session ID must win even when its group and message payload
	// do not help the fallback matcher identify the request.
	if got := bridge.matchHistoryRequest("protocol-current", []string{"unknown@g.us"}, nil); got != "request-current" {
		t.Fatalf("protocol session ID matched %q, want request-current", got)
	}
	if len(bridge.pendingHistory) != 1 || bridge.pendingHistory[0].requestID != "request-old" {
		t.Fatalf("exact correlation removed the wrong pending request: %#v", bridge.pendingHistory)
	}
}

func TestMatchHistoryPrunesExpiredRequestsBeforeMatchingAnEmptyResponse(t *testing.T) {
	bridge := testBridge(context.Background())
	now := time.Now()
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "expired", protocolID: "expired-protocol", groupID: "old@g.us", requestedAt: now.Add(-historyCorrelationTTL - time.Second)},
		{requestID: "active", protocolID: "active-protocol", groupID: "current@g.us", requestedAt: now},
	}

	if got := bridge.matchHistoryRequest("", nil, nil); got != "active" {
		t.Fatalf("empty response matched %q, want the only unexpired request", got)
	}
	if len(bridge.pendingHistory) != 0 {
		t.Fatalf("expired or matched request remained pending: %#v", bridge.pendingHistory)
	}
}

func TestPendingHistoryCorrelationStorageIsBounded(t *testing.T) {
	bridge := testBridge(context.Background())
	for i := 0; i < maxPendingHistoryCorrelations+1; i++ {
		bridge.appendPendingHistory(pendingHistoryRequest{requestID: fmt.Sprintf("request-%d", i), requestedAt: time.Now()})
	}

	if len(bridge.pendingHistory) != maxPendingHistoryCorrelations {
		t.Fatalf("pending correlation count = %d, want max %d", len(bridge.pendingHistory), maxPendingHistoryCorrelations)
	}
	if bridge.pendingHistory[0].requestID != "request-1" {
		t.Fatalf("oldest pending request = %q, want request-1 after dropping the oldest entry", bridge.pendingHistory[0].requestID)
	}
}

func TestEmitHistoryCarriesProtocolSessionIDIntoBatch(t *testing.T) {
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.pendingHistory = []pendingHistoryRequest{{
		requestID: "request-id", protocolID: "protocol-id", attemptID: 7,
		groupID: "supplier@g.us", messageID: "anchor", timestampSec: 200,
	}}
	bridge.emitHistory(&events.HistorySync{
		Data:         &waHistorySync.HistorySync{SyncType: waHistorySync.HistorySync_ON_DEMAND.Enum()},
		Notification: &waE2E.HistorySyncNotification{PeerDataRequestSessionID: proto.String("protocol-id")},
	})
	var got struct {
		Batch historyBatch `json:"batch"`
	}
	if err := json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode history batch: %v", err)
	}
	if got.Batch.RequestID != "request-id" {
		t.Fatalf("history batch request ID = %q, want request-id", got.Batch.RequestID)
	}
}

func TestEmitHistoryParsesBatchAndEmitsMessagesChronologically(t *testing.T) {
	const groupID = "120363000000000000@g.us"
	const participantID = "15551234567@s.whatsapp.net"
	const protocolID = "history-session"

	webMessage := func(id, text string, timestamp uint64) *waWeb.WebMessageInfo {
		return &waWeb.WebMessageInfo{
			Key: &waCommon.MessageKey{
				RemoteJID:   proto.String(groupID),
				ID:          proto.String(id),
				FromMe:      proto.Bool(false),
				Participant: proto.String(participantID),
			},
			Message:          &waE2E.Message{Conversation: proto.String(text)},
			MessageTimestamp: proto.Uint64(timestamp),
			Participant:      proto.String(participantID),
		}
	}

	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.setSupplierGroups([]string{groupID})
	bridge.pendingHistory = []pendingHistoryRequest{{
		requestID: "request-id", protocolID: protocolID, groupID: groupID,
		messageID: "anchor", timestampSec: 300,
	}}
	bridge.emitHistory(&events.HistorySync{
		Data: &waHistorySync.HistorySync{
			SyncType: waHistorySync.HistorySync_ON_DEMAND.Enum(),
			Conversations: []*waHistorySync.Conversation{{
				ID: proto.String(groupID),
				// WhatsApp's wire order is deliberately newest first.
				Messages: []*waHistorySync.HistorySyncMsg{
					{Message: webMessage("newer", "newer body", 300)},
					{Message: webMessage("older", "older body", 100)},
				},
			}},
		},
		Notification: &waE2E.HistorySyncNotification{PeerDataRequestSessionID: proto.String(protocolID)},
	})

	lines := strings.Split(strings.TrimSpace(writer.snapshot()), "\n")
	if len(lines) != 3 {
		t.Fatalf("emitted %d JSON records, want one batch and two messages: %s", len(lines), writer.snapshot())
	}
	var batchRecord struct {
		Type  string       `json:"type"`
		Event string       `json:"event"`
		Batch historyBatch `json:"batch"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &batchRecord); err != nil {
		t.Fatalf("decode history batch: %v", err)
	}
	if batchRecord.Type != "event" || batchRecord.Event != "history-batch" || !batchRecord.Batch.OnDemand {
		t.Fatalf("first record is not an on-demand history batch: %#v", batchRecord)
	}
	if batchRecord.Batch.RequestID != "request-id" || len(batchRecord.Batch.GroupIDs) != 1 || batchRecord.Batch.GroupIDs[0] != groupID {
		t.Fatalf("history batch correlation/group metadata = %#v", batchRecord.Batch)
	}
	if len(batchRecord.Batch.Messages) != 2 || batchRecord.Batch.Messages[0].Key.ID != "newer" || batchRecord.Batch.Messages[1].Key.ID != "older" {
		t.Fatalf("history batch references do not preserve both received messages: %#v", batchRecord.Batch.Messages)
	}

	var emitted []messagePayload
	for _, line := range lines[1:] {
		var record struct {
			Type    string         `json:"type"`
			Event   string         `json:"event"`
			Message messagePayload `json:"message"`
		}
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("decode history message: %v", err)
		}
		if record.Type != "event" || record.Event != "message" {
			t.Fatalf("unexpected history record: %#v", record)
		}
		emitted = append(emitted, record.Message)
	}
	if emitted[0].MessageID != "older" || emitted[0].Text != "older body" || emitted[0].TimestampMs != 100_000 {
		t.Fatalf("first emitted history message = %#v, want the oldest message", emitted[0])
	}
	if emitted[1].MessageID != "newer" || emitted[1].Text != "newer body" || emitted[1].TimestampMs != 300_000 {
		t.Fatalf("second emitted history message = %#v, want the newest message", emitted[1])
	}
}

func TestUnknownProtocolSessionIDDoesNotFallBackToAnotherRequest(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "current", protocolID: "current-protocol", groupID: "supplier@g.us", messageID: "anchor", timestampSec: 200},
	}
	page := []historyReference{{Key: struct {
		RemoteJID   string `json:"remoteJid"`
		ID          string `json:"id"`
		FromMe      bool   `json:"fromMe"`
		Participant string `json:"participant,omitempty"`
	}{RemoteJID: "supplier@g.us", ID: "message"}, MessageTimestamp: 190}}
	if got := bridge.matchHistoryRequest("expired-protocol", []string{"supplier@g.us"}, page); got != "" {
		t.Fatalf("unknown protocol ID was incorrectly assigned to %q", got)
	}
	if len(bridge.pendingHistory) != 1 || bridge.pendingHistory[0].requestID != "current" {
		t.Fatalf("unknown protocol ID consumed the current request: %#v", bridge.pendingHistory)
	}
}

func TestLateResponseFromPreviousAttemptKeepsCurrentAttemptRequest(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "previous-attempt", protocolID: "protocol-old", attemptID: 1, groupID: "supplier@g.us", messageID: "same-anchor", timestampSec: 200},
		{requestID: "current-attempt", protocolID: "protocol-current", attemptID: 2, groupID: "supplier@g.us", messageID: "same-anchor", timestampSec: 200},
	}
	if got := bridge.matchHistoryRequest("protocol-old", nil, nil); got != "previous-attempt" {
		t.Fatalf("late response matched %q, want previous-attempt", got)
	}
	if len(bridge.pendingHistory) != 1 || bridge.pendingHistory[0].requestID != "current-attempt" {
		t.Fatalf("late response removed the active attempt's request: %#v", bridge.pendingHistory)
	}
}

func TestEmptyHistoryResponseDoesNotConsumeAnAmbiguousRequest(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "old-group", groupID: "first@g.us", messageID: "anchor-a", timestampSec: 200},
		{requestID: "current-group", groupID: "second@g.us", messageID: "anchor-b", timestampSec: 100},
	}
	if got := bridge.matchHistoryRequest("", nil, nil); got != "" {
		t.Fatalf("ambiguous empty response matched %q", got)
	}
	if len(bridge.pendingHistory) != 2 {
		t.Fatalf("ambiguous empty response consumed a request: %#v", bridge.pendingHistory)
	}
}

func TestHistoryResponseWithSameSecondAnchorsRemainsUncorrelated(t *testing.T) {
	bridge := testBridge(context.Background())
	bridge.pendingHistory = []pendingHistoryRequest{
		{requestID: "first-anchor", groupID: "supplier@g.us", messageID: "anchor-a", timestampSec: 200},
		{requestID: "second-anchor", groupID: "supplier@g.us", messageID: "anchor-b", timestampSec: 200},
	}
	page := []historyReference{{Key: struct {
		RemoteJID   string `json:"remoteJid"`
		ID          string `json:"id"`
		FromMe      bool   `json:"fromMe"`
		Participant string `json:"participant,omitempty"`
	}{RemoteJID: "supplier@g.us", ID: "message"}, MessageTimestamp: 190}}
	if got := bridge.matchHistoryRequest("", []string{"supplier@g.us"}, page); got != "" {
		t.Fatalf("response matched one of two indistinguishable second-level anchors: %q", got)
	}
	if len(bridge.pendingHistory) != 2 {
		t.Fatalf("ambiguous response consumed a request: %#v", bridge.pendingHistory)
	}
}

func TestMessageQueuePreservesArrivalOrder(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := &messageTestWriter{changed: make(chan struct{}, 4)}
	bridge := testBridge(ctx)
	bridge.output = json.NewEncoder(writer)
	bridge.messageQueue = make(chan messageTask, 2)
	done := make(chan struct{})
	go func() { bridge.processMessageQueue(); close(done) }()
	bridge.enqueueMessageTask(messageTask{event: textEvent(t, "first", "first body"), messageType: "notify"})
	bridge.enqueueMessageTask(messageTask{event: textEvent(t, "second", "second body"), messageType: "notify"})

	records := writer.waitFor(t, 2)
	cancel()
	<-done
	if records[0].Message.MessageID != "first" || records[1].Message.MessageID != "second" {
		t.Fatalf("message order = [%s %s], want [first second]", records[0].Message.MessageID, records[1].Message.MessageID)
	}
}

func TestLiveMessageWithoutTimestampUsesReceiptTime(t *testing.T) {
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	before := time.Now().UnixMilli()
	event := &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true}, ID: "missing-live-time"},
		Message: &waE2E.Message{Conversation: proto.String("message")},
	}
	bridge.emitMessage(event, "notify")
	var got recordedMessage
	if err = json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode emitted message: %v", err)
	}
	if got.Message.TimestampMs < before || got.Message.TimestampMs > time.Now().UnixMilli() {
		t.Fatalf("fallback live timestamp = %d, expected a receipt time after %d", got.Message.TimestampMs, before)
	}
}

func TestEmitMessageDoesNotDownloadMediaOutsideSupplierGroups(t *testing.T) {
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.setSupplierGroups([]string{"120363111111111111@g.us", "not-a-group@s.whatsapp.net", "invalid"})
	event := &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true}, ID: "non-supplier-image", Timestamp: time.Unix(1_700_000_000, 0)},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg"), Caption: proto.String("photo caption"), MediaKey: []byte("test-key")}},
	}
	bridge.emitMessage(event, "notify")

	var got struct {
		Message messagePayload `json:"message"`
	}
	if err := json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode emitted message: %v", err)
	}
	if got.Message.MimeType != "image/jpeg" || got.Message.Text != "" || got.Message.ImageBase64 != "" || got.Message.MediaDownloadError {
		t.Fatalf("non-supplier media payload = %#v, want metadata without message content, downloaded bytes, or an error", got.Message)
	}
}

func TestEmitMessageDoesNotDownloadOwnSupplierMedia(t *testing.T) {
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.setSupplierGroups([]string{group.String()})
	bridge.emitMessage(&events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true, IsFromMe: true}, ID: "own-photo", Timestamp: time.Unix(1_700_000_000, 0)},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("private caption"), Mimetype: proto.String("image/jpeg")}},
	}, "notify")
	var got struct {
		Message messagePayload `json:"message"`
	}
	if err = json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode emitted own supplier message: %v", err)
	}
	if got.Message.MessageID != "own-photo" || !got.Message.FromMe || got.Message.GroupID != group.String() {
		t.Fatalf("own message reference was not preserved: %#v", got.Message)
	}
	if got.Message.Text != "" || got.Message.ImageBase64 != "" || got.Message.MediaDownloadError {
		t.Fatalf("own supplier content should not be copied or downloaded: %#v", got.Message)
	}
}

func TestEmitMessageRejectsSupplierImagesOverTheCatalogLimitBeforeDownloading(t *testing.T) {
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.setSupplierGroups([]string{group.String()})
	bridge.emitMessage(&events.Message{
		Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true}, ID: "oversized-photo", Timestamp: time.Unix(1_700_000_000, 0)},
		Message: &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"), MediaKey: []byte("key"), FileLength: proto.Uint64(uint64(maxSupplierImageBytes + 1)),
		}},
	}, "notify")

	var got struct {
		Message messagePayload `json:"message"`
	}
	if err = json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode oversized media result: %v", err)
	}
	if !got.Message.MediaDownloadError || got.Message.ImageBase64 != "" {
		t.Fatalf("oversized supplier photo result = %#v, want a download error and no image bytes", got.Message)
	}
}

func TestEmitMessageUnwrapsNestedSupplierContentLikeBaileys(t *testing.T) {
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	writer := &messageTestWriter{}
	bridge := testBridge(context.Background())
	bridge.output = json.NewEncoder(writer)
	bridge.setSupplierGroups([]string{group.String()})
	image := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption: proto.String("CAJA $35.000"), Mimetype: proto.String("image/jpeg"),
		MediaKey: []byte("key"), FileLength: proto.Uint64(uint64(maxSupplierImageBytes + 1)),
	}}
	wrapped := &waE2E.Message{ViewOnceMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{
		EphemeralMessage: &waE2E.FutureProofMessage{Message: image},
	}}}
	bridge.emitMessage(&events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true}, ID: "wrapped-photo", Timestamp: time.Unix(1_700_000_000, 0)},
		Message: wrapped,
	}, "notify")

	var got struct {
		Message messagePayload `json:"message"`
	}
	if err = json.NewDecoder(strings.NewReader(writer.snapshot())).Decode(&got); err != nil {
		t.Fatalf("decode nested message payload: %v", err)
	}
	if got.Message.Text != "CAJA $35.000" || got.Message.MimeType != "image/jpeg" || !got.Message.MediaDownloadError {
		t.Fatalf("nested supplier content = %#v, want caption/image metadata and the pre-download size rejection", got.Message)
	}
}

func TestSizeLimitedMediaFileRejectsWritesBeyondLimit(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "bounded-media-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	limited := sizeLimitedMediaFile{File: file, maxBytes: 8}

	if n, writeErr := limited.Write([]byte("123456789")); n != 0 || !errors.Is(writeErr, errSupplierImageTooLarge) {
		t.Fatalf("oversized sequential write = (%d, %v), want (0, errSupplierImageTooLarge)", n, writeErr)
	}
	if n, writeErr := limited.Write([]byte("12345678")); n != 8 || writeErr != nil {
		t.Fatalf("write within limit = (%d, %v), want (8, nil)", n, writeErr)
	}
	if n, writeErr := limited.WriteAt([]byte("x"), 8); n != 0 || !errors.Is(writeErr, errSupplierImageTooLarge) {
		t.Fatalf("oversized positioned write = (%d, %v), want (0, errSupplierImageTooLarge)", n, writeErr)
	}
	if err = limited.Truncate(9); !errors.Is(err, errSupplierImageTooLarge) {
		t.Fatalf("oversized truncate error = %v, want errSupplierImageTooLarge", err)
	}
}

func TestSizeLimitedMediaFileTruncatesPartialBytesBeforeARewoundRetry(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "retry-media-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	limited := sizeLimitedMediaFile{File: file, maxBytes: 32}

	if _, err = limited.Write([]byte("partial response tail")); err != nil {
		t.Fatalf("write first partial response: %v", err)
	}
	if _, err = limited.Seek(0, io.SeekStart); err != nil {
		t.Fatalf("rewind before retry: %v", err)
	}
	if _, err = limited.Write([]byte("ok")); err != nil {
		t.Fatalf("write retry response: %v", err)
	}
	got, err := os.ReadFile(file.Name())
	if err != nil {
		t.Fatalf("read retried response: %v", err)
	}
	if string(got) != "ok" {
		t.Fatalf("retried file = %q, want only the second response without stale tail bytes", got)
	}
}

func TestReadSupplierImageRejectsOversizedDecryptedMedia(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "oversized-media-*")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	bounded := sizeLimitedMediaFile{File: file, maxBytes: maxSupplierImageBytes + maxEncryptedImageOverhead}
	if err = bounded.Truncate(maxSupplierImageBytes + 1); err != nil {
		t.Fatalf("create sparse oversized image: %v", err)
	}
	if _, err = readSupplierImage(bounded); !errors.Is(err, errSupplierImageTooLarge) {
		t.Fatalf("oversized decoded image error = %v, want errSupplierImageTooLarge", err)
	}
}

func TestExpiredMediaErrorsUsePhoneReuploadAndUpdateTheNewDirectPath(t *testing.T) {
	for _, err := range []error{
		whatsmeow.ErrMediaDownloadFailedWith403,
		whatsmeow.ErrMediaDownloadFailedWith404,
		whatsmeow.ErrMediaDownloadFailedWith410,
	} {
		if !isExpiredMediaError(err) {
			t.Errorf("expired media error %v was not recognized", err)
		}
	}
	if isExpiredMediaError(os.ErrNotExist) {
		t.Fatal("a local file error was incorrectly classified as an expired WhatsApp media URL")
	}

	image := &waE2E.ImageMessage{DirectPath: proto.String("/expired")}
	if err := setMediaDirectPath(image, "/re-uploaded"); err != nil {
		t.Fatalf("setMediaDirectPath returned an error: %v", err)
	}
	if got := image.GetDirectPath(); got != "/re-uploaded" {
		t.Fatalf("image direct path = %q, want /re-uploaded", got)
	}
	if err := setMediaDirectPath(image, ""); err == nil {
		t.Fatal("an empty re-upload path unexpectedly succeeded")
	}
}

func TestInitializeCleansStaleTemporaryMediaFiles(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "account.sqlite")
	mediaTempDir := databasePath + ".media-tmp"
	if err := os.MkdirAll(mediaTempDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaTempDir, "supplier-image-stale"), []byte("temporary image content"), 0o600); err != nil {
		t.Fatal(err)
	}

	bridge := testBridge(context.Background())
	if err := bridge.initialize(databasePath, strings.Repeat("cd", 32)); err != nil {
		t.Fatalf("initialize bridge: %v", err)
	}
	defer bridge.close()
	if bridge.mediaTempDir != mediaTempDir {
		t.Fatalf("media temporary directory = %q, want %q", bridge.mediaTempDir, mediaTempDir)
	}
	entries, err := os.ReadDir(mediaTempDir)
	if err != nil {
		t.Fatalf("read temporary media directory: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("temporary media directory retained stale files: %#v", entries)
	}
}

func TestEncryptedStorePersistsSignalSessionsAndRejectsWrongKey(t *testing.T) {
	ctx := context.Background()
	databasePath := filepath.Join(t.TempDir(), "account.sqlite")
	key := strings.Repeat("ab", 32)

	first := testBridge(ctx)
	if err := first.initialize(databasePath, key); err != nil {
		t.Fatalf("initialize first store: %v", err)
	}
	if !store.DeviceProps.GetRequireFullSync() {
		t.Fatal("new companion registration must request full history sync")
	}
	if !first.client.EnableAutoReconnect || first.client.InitialAutoReconnect {
		t.Fatal("a new, unpaired store must reconnect after established disconnects but leave the first QR dial under application control")
	}
	accountJID, err := types.ParseJID("15551234567:2@s.whatsapp.net")
	if err != nil {
		t.Fatal(err)
	}
	first.client.Store.ID = &accountJID
	first.client.Store.Account = &waAdv.ADVSignedDeviceIdentity{
		Details:             []byte{},
		AccountSignature:    bytes.Repeat([]byte{1}, 64),
		AccountSignatureKey: bytes.Repeat([]byte{2}, 32),
		DeviceSignature:     bytes.Repeat([]byte{3}, 64),
	}
	if err = first.client.Store.Save(ctx); err != nil {
		t.Fatalf("save device credentials: %v", err)
	}
	const sessionAddress = "15557654321:3@s.whatsapp.net"
	signalSession := []byte("test-signal-session-material")
	if err = first.client.Store.Sessions.PutSession(ctx, sessionAddress, signalSession); err != nil {
		t.Fatalf("save Signal session: %v", err)
	}
	first.close()

	fileBytes, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatalf("read encrypted database: %v", err)
	}
	if bytes.HasPrefix(fileBytes, []byte("SQLite format 3\x00")) {
		t.Fatal("session database has an unencrypted SQLite header")
	}
	if bytes.Contains(fileBytes, signalSession) {
		t.Fatal("Signal session material appears in plaintext in the database")
	}

	restored := testBridge(ctx)
	if err = restored.initialize(databasePath, key); err != nil {
		t.Fatalf("reopen encrypted store: %v", err)
	}
	defer restored.close()
	if restored.client.Store.ID == nil || restored.client.Store.ID.String() != accountJID.String() {
		t.Fatalf("device identity was not restored: %#v", restored.client.Store.ID)
	}
	if !restored.client.EnableAutoReconnect || !restored.client.InitialAutoReconnect {
		t.Fatal("a restored pairing must automatically reconnect after an initial network failure")
	}
	savedSession, err := restored.client.Store.Sessions.GetSession(ctx, sessionAddress)
	if err != nil {
		t.Fatalf("read restored Signal session: %v", err)
	}
	if !bytes.Equal(savedSession, signalSession) {
		t.Fatalf("restored Signal session = %q, want persisted session material", savedSession)
	}

	wrongKey := testBridge(ctx)
	defer wrongKey.close()
	if err = wrongKey.initialize(databasePath, strings.Repeat("cd", 32)); err == nil {
		t.Fatal("opening the encrypted store with a different key unexpectedly succeeded")
	}
}

func testBridge(ctx context.Context) *bridge {
	return &bridge{ctx: ctx, cancel: func() {}, input: make(chan command), output: json.NewEncoder(&bytes.Buffer{})}
}

type recordedMessage struct {
	Message messagePayload `json:"message"`
}

type messageTestWriter struct {
	mu      sync.Mutex
	data    strings.Builder
	changed chan struct{}
}

func (w *messageTestWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	count, err := w.data.Write(value)
	if w.changed != nil {
		select {
		case w.changed <- struct{}{}:
		default:
		}
	}
	return count, err
}

func (w *messageTestWriter) snapshot() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.data.String()
}

func (w *messageTestWriter) waitFor(t *testing.T, count int) []recordedMessage {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		var records []recordedMessage
		for _, line := range strings.Split(strings.TrimSpace(w.snapshot()), "\n") {
			if line == "" {
				continue
			}
			var record recordedMessage
			if err := json.Unmarshal([]byte(line), &record); err != nil {
				t.Fatalf("decode recorded message: %v", err)
			}
			records = append(records, record)
		}
		if len(records) >= count {
			return records
		}
		select {
		case <-w.changed:
		case <-deadline:
			t.Fatalf("received %d records, wanted %d", len(records), count)
		}
	}
}

func textEvent(t *testing.T, id, text string) *events.Message {
	t.Helper()
	group, err := types.ParseJID("120363000000000000@g.us")
	if err != nil {
		t.Fatal(err)
	}
	return &events.Message{
		Info:    types.MessageInfo{MessageSource: types.MessageSource{Chat: group, IsGroup: true}, ID: types.MessageID(id), Timestamp: time.Unix(1_700_000_000, 0)},
		Message: &waE2E.Message{Conversation: proto.String(text)},
	}
}
