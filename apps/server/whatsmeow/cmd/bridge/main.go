package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/mutecomm/go-sqlcipher/v4"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waMmsRetry"
	"go.mau.fi/whatsmeow/socket"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

const maxCommandBytes = 40 * 1024 * 1024
const historyRequestAckTimeout = 15 * time.Second
const historyCorrelationTTL = 24 * time.Hour
const maxPendingHistoryCorrelations = 4096
const maxSupplierImageBytes int64 = 20 * 1024 * 1024
const maxEncryptedImageOverhead int64 = 1024
const maxMessageWrapperDepth = 5

var errSupplierImageTooLarge = errors.New("supplier image exceeds 20 MiB")

func whatsAppHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	tlsConfig := transport.TLSClientConfig
	if tlsConfig == nil {
		tlsConfig = &tls.Config{}
	} else {
		tlsConfig = tlsConfig.Clone()
	}
	// This route resets Go's TLS 1.3 handshake before requests to WhatsApp Web
	// and its media hosts. Scope TLS 1.2 to whatsmeow's HTTP clients.
	tlsConfig.MinVersion = tls.VersionTLS12
	tlsConfig.MaxVersion = tls.VersionTLS12
	transport.TLSClientConfig = tlsConfig
	return &http.Client{Transport: transport}
}

type sizeLimitedMediaFile struct {
	*os.File
	maxBytes int64
}

func (file sizeLimitedMediaFile) Write(data []byte) (int, error) {
	position, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	// DownloadToFile seeks back to the beginning before retrying a transient
	// network failure, but doesn't truncate a partial response. Reset it on the
	// first write of the next attempt so stale tail bytes cannot break the hash.
	if position == 0 {
		info, statErr := file.Stat()
		if statErr != nil {
			return 0, statErr
		}
		if info.Size() > 0 {
			if err = file.Truncate(0); err != nil {
				return 0, err
			}
		}
	}
	if position < 0 || position > file.maxBytes || int64(len(data)) > file.maxBytes-position {
		return 0, errSupplierImageTooLarge
	}
	return file.File.Write(data)
}

func (file sizeLimitedMediaFile) WriteAt(data []byte, offset int64) (int, error) {
	if offset < 0 || offset > file.maxBytes || int64(len(data)) > file.maxBytes-offset {
		return 0, errSupplierImageTooLarge
	}
	return file.File.WriteAt(data, offset)
}

func (file sizeLimitedMediaFile) Truncate(size int64) error {
	if size < 0 || size > file.maxBytes {
		return errSupplierImageTooLarge
	}
	return file.File.Truncate(size)
}

type command struct {
	ID               string   `json:"id"`
	Type             string   `json:"type"`
	DatabasePath     string   `json:"databasePath,omitempty"`
	EncryptionKey    string   `json:"encryptionKey,omitempty"`
	SupplierGroupIDs []string `json:"supplierGroupIds,omitempty"`
	RequestID        string   `json:"requestId,omitempty"`
	GroupID          string   `json:"groupId,omitempty"`
	MessageID        string   `json:"messageId,omitempty"`
	AttemptID        int64    `json:"attemptId,omitempty"`
	TimestampSec     int64    `json:"timestampSec,omitempty"`
	FromMe           bool     `json:"fromMe,omitempty"`
	ImageBase64      string   `json:"imageBase64,omitempty"`
	MimeType         string   `json:"mimeType,omitempty"`
	Caption          string   `json:"caption,omitempty"`
}

type envelope struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	Event     string `json:"event,omitempty"`
	OK        bool   `json:"ok,omitempty"`
	Error     string `json:"error,omitempty"`
	Status    string `json:"status,omitempty"`
	QR        string `json:"qr,omitempty"`
	Paired    bool   `json:"paired,omitempty"`
	Groups    any    `json:"groups,omitempty"`
	Message   any    `json:"message,omitempty"`
	Batch     any    `json:"batch,omitempty"`
	MessageID string `json:"messageId,omitempty"`
	Retryable bool   `json:"retryable,omitempty"`
}

type messagePayload struct {
	GroupID             string `json:"groupId"`
	MessageID           string `json:"messageId"`
	ParticipantID       string `json:"participantId,omitempty"`
	TimestampMs         int64  `json:"timestampMs"`
	FromMe              bool   `json:"fromMe"`
	Type                string `json:"type"`
	Text                string `json:"text,omitempty"`
	ImageBase64         string `json:"imageBase64,omitempty"`
	MimeType            string `json:"mimeType,omitempty"`
	ExpectedAlbumImages int    `json:"expectedAlbumImages,omitempty"`
	MediaDownloadError  bool   `json:"mediaDownloadError,omitempty"`
}

type historyReference struct {
	Key struct {
		RemoteJID   string `json:"remoteJid"`
		ID          string `json:"id"`
		FromMe      bool   `json:"fromMe"`
		Participant string `json:"participant,omitempty"`
	} `json:"key"`
	MessageTimestamp int64 `json:"messageTimestamp"`
}

type historyBatch struct {
	OnDemand  bool               `json:"onDemand"`
	RequestID string             `json:"requestId,omitempty"`
	GroupIDs  []string           `json:"groupIds"`
	Messages  []historyReference `json:"messages"`
}

type pendingHistoryRequest struct {
	requestID    string
	protocolID   string
	attemptID    int64
	groupID      string
	messageID    string
	timestampSec int64
	requestedAt  time.Time
}

type pendingMediaRetry struct {
	mediaKey []byte
	result   chan mediaRetryResult
}

type mediaRetryResult struct {
	directPath string
	err        error
}

type messageTask struct {
	event        *events.Message
	history      *events.HistorySync
	decryptError *messagePayload
	messageType  string
}

type bridge struct {
	ctx              context.Context
	cancel           context.CancelFunc
	input            chan command
	output           *json.Encoder
	outputMu         sync.Mutex
	client           *whatsmeow.Client
	container        *sqlstore.Container
	db               *sql.DB
	mediaTempDir     string
	paired           bool
	messageQueue     chan messageTask
	supplierGroupsMu sync.RWMutex
	supplierGroups   map[string]struct{}

	historyMu      sync.Mutex
	pendingHistory []pendingHistoryRequest
	mediaRetryMu   sync.Mutex
	pendingMedia   map[string]pendingMediaRetry
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "whatsmeow bridge stopped:", err)
		os.Exit(1)
	}
}

func run() error {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxCommandBytes)
	if !scanner.Scan() {
		return errors.New("missing initialization command")
	}
	var init command
	if err := json.Unmarshal(scanner.Bytes(), &init); err != nil {
		return fmt.Errorf("invalid initialization command: %w", err)
	}
	if init.Type != "initialize" || init.DatabasePath == "" || len(init.EncryptionKey) != 64 {
		return errors.New("invalid initialization settings")
	}

	ctx, cancel := context.WithCancel(context.Background())
	b := &bridge{ctx: ctx, cancel: cancel, input: make(chan command), output: json.NewEncoder(os.Stdout), pendingMedia: make(map[string]pendingMediaRetry), messageQueue: make(chan messageTask, 512), supplierGroups: make(map[string]struct{})}
	b.setSupplierGroups(init.SupplierGroupIDs)
	if err := b.initialize(init.DatabasePath, init.EncryptionKey); err != nil {
		cancel()
		return err
	}
	go b.processMessageQueue()
	if err := b.emit(envelope{Type: "ready", Paired: b.paired}); err != nil {
		b.close()
		return err
	}
	go b.readCommands(scanner)
	for cmd := range b.input {
		b.handleCommand(cmd)
		if cmd.Type == "shutdown" {
			break
		}
	}
	b.close()
	return nil
}

func (b *bridge) initialize(databasePath, keyHex string) error {
	// Match Baileys' syncFullHistory registration request. This is a library
	// process-global setting; each WhatsApp account runs in its own sidecar.
	store.DeviceProps.RequireFullSync = proto.Bool(true)
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		return fmt.Errorf("create encrypted store directory: %w", err)
	}
	absolutePath, err := filepath.Abs(databasePath)
	if err != nil {
		return fmt.Errorf("resolve store path: %w", err)
	}
	mediaTempDir := absolutePath + ".media-tmp"
	if err = os.RemoveAll(mediaTempDir); err != nil {
		return fmt.Errorf("remove stale temporary media files: %w", err)
	}
	if err = os.MkdirAll(mediaTempDir, 0o700); err != nil {
		return fmt.Errorf("create temporary media directory: %w", err)
	}
	storeURL := url.URL{Scheme: "file", Path: filepath.ToSlash(absolutePath)}
	query := storeURL.Query()
	query.Set("_pragma_key", "x'"+keyHex+"'")
	query.Set("_pragma_cipher_page_size", "4096")
	query.Set("_foreign_keys", "on")
	query.Set("_busy_timeout", "5000")
	storeURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite3", storeURL.String())
	if err != nil {
		return fmt.Errorf("open encrypted whatsmeow store: %w", err)
	}
	db.SetMaxOpenConns(1)
	container := sqlstore.NewWithDB(db, "sqlite3", waLog.Noop)
	if err = container.Upgrade(b.ctx); err != nil {
		_ = db.Close()
		return fmt.Errorf("initialize encrypted whatsmeow store: %w", err)
	}
	device, err := container.GetFirstDevice(b.ctx)
	if err != nil {
		_ = container.Close()
		return fmt.Errorf("load whatsmeow account: %w", err)
	}
	client := whatsmeow.NewClient(device, waLog.Noop)
	whatsAppHTTP := whatsAppHTTPClient()
	client.SetPreLoginHTTPClient(whatsAppHTTP)
	client.SetWebsocketHTTPClient(whatsAppHTTP)
	client.SetMediaHTTPClient(whatsAppHTTP)
	client.EnableAutoReconnect = true
	client.InitialAutoReconnect = device.ID != nil
	b.db = db
	b.container = container
	b.client = client
	b.mediaTempDir = mediaTempDir
	b.paired = device.ID != nil
	client.AddEventHandler(b.handleEvent)
	return nil
}

func (b *bridge) readCommands(scanner *bufio.Scanner) {
	defer close(b.input)
	for scanner.Scan() {
		var cmd command
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			_ = b.emit(envelope{Type: "response", Error: "Invalid command"})
			continue
		}
		b.input <- cmd
	}
}

func (b *bridge) handleCommand(cmd command) {
	ctx, cancel := context.WithTimeout(b.ctx, 90*time.Second)
	defer cancel()
	var err error
	var result envelope
	result.Type = "response"
	result.ID = cmd.ID
	switch cmd.Type {
	case "connect":
		if !b.client.IsConnected() {
			if b.client.Store.ID == nil {
				qrChannel, qrErr := b.client.GetQRChannel(b.ctx)
				if qrErr != nil {
					err = qrErr
					break
				}
				go b.readQR(qrChannel)
			}
			err = b.client.ConnectContext(b.ctx)
		}
	case "disconnect":
		b.client.Disconnect()
	case "groups":
		var groups []*types.GroupInfo
		groups, err = b.client.GetJoinedGroups(ctx)
		if err == nil {
			type groupItem struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			}
			items := make([]groupItem, 0, len(groups))
			for _, group := range groups {
				items = append(items, groupItem{ID: group.JID.String(), Name: group.Name})
			}
			result.Groups = items
		}
	case "supplier-groups":
		b.setSupplierGroups(cmd.SupplierGroupIDs)
	case "history":
		err = b.requestHistory(ctx, cmd)
	case "send-image":
		result.MessageID, err = b.sendImage(ctx, cmd)
	case "shutdown":
		b.client.Disconnect()
	default:
		err = errors.New("unsupported command")
	}
	if err != nil {
		result.OK = false
		result.Error = safeError(err)
		if cmd.Type == "connect" && b.client.Store.ID == nil {
			result.Retryable = isRetryableConnectError(err)
		}
	} else {
		result.OK = true
	}
	_ = b.emit(result)
}

func (b *bridge) readQR(qrChannel <-chan whatsmeow.QRChannelItem) {
	for item := range qrChannel {
		if item.Event == whatsmeow.QRChannelEventCode && item.Code != "" {
			_ = b.emit(envelope{Type: "event", Event: "qr", QR: item.Code})
		} else if item.Event == "success" {
			_ = b.emit(envelope{Type: "event", Event: "paired", Paired: true})
		} else if item.Event == whatsmeow.QRChannelTimeout.Event {
			_ = b.emit(envelope{Type: "event", Event: "qr-expired"})
		} else if item.Event == whatsmeow.QRChannelEventError {
			_ = b.emit(envelope{Type: "event", Event: "connection-error", Error: safeError(item.Error)})
		}
	}
}

func (b *bridge) handleEvent(evt any) {
	switch event := evt.(type) {
	case *events.Connected:
		_ = b.emit(envelope{Type: "event", Event: "connected", Paired: true})
	case *events.Disconnected:
		_ = b.emit(envelope{Type: "event", Event: "disconnected"})
	case *events.LoggedOut:
		_ = b.emit(envelope{Type: "event", Event: "logged-out"})
	case *events.StreamReplaced:
		_ = b.emit(envelope{Type: "event", Event: "disconnected", Error: "La sesión se abrió en otro dispositivo vinculado."})
	case *events.ClientOutdated:
		_ = b.emit(envelope{Type: "event", Event: "connection-error", Error: "WhatsApp rechazó esta versión del cliente. Actualiza whatsmeow y vuelve a intentar."})
	case *events.UndecryptableMessage:
		if event.Info.IsGroup {
			payload := messagePayload{GroupID: event.Info.Chat.String(), MessageID: string(event.Info.ID), ParticipantID: event.Info.Sender.String(), TimestampMs: event.Info.Timestamp.UnixMilli(), Type: "decrypt-failed"}
			b.enqueueMessageTask(messageTask{decryptError: &payload})
		}
	case *events.Message:
		b.enqueueMessageTask(messageTask{event: event, messageType: "notify"})
	case *events.HistorySync:
		b.enqueueMessageTask(messageTask{history: event})
	case *events.JoinedGroup, *events.GroupInfo:
		_ = b.emit(envelope{Type: "event", Event: "groups-updated"})
	case *events.MediaRetry:
		b.handleMediaRetry(event)
	}
}

func (b *bridge) setSupplierGroups(groupIDs []string) {
	groups := make(map[string]struct{}, len(groupIDs))
	for _, groupID := range groupIDs {
		if parsed, err := types.ParseJID(groupID); err == nil && parsed.Server == types.GroupServer {
			groups[parsed.String()] = struct{}{}
		}
	}
	b.supplierGroupsMu.Lock()
	b.supplierGroups = groups
	b.supplierGroupsMu.Unlock()
}

func (b *bridge) isSupplierGroup(groupID string) bool {
	b.supplierGroupsMu.RLock()
	_, exists := b.supplierGroups[groupID]
	b.supplierGroupsMu.RUnlock()
	return exists
}

func (b *bridge) enqueueMessageTask(task messageTask) {
	select {
	case b.messageQueue <- task:
	case <-b.ctx.Done():
	}
}

func (b *bridge) processMessageQueue() {
	for {
		select {
		case <-b.ctx.Done():
			return
		case task := <-b.messageQueue:
			switch {
			case task.history != nil:
				b.emitHistory(task.history)
			case task.event != nil:
				b.emitMessage(task.event, task.messageType)
			case task.decryptError != nil:
				_ = b.emit(envelope{Type: "event", Event: "message", Message: task.decryptError})
			}
		}
	}
}

func (b *bridge) emitHistory(event *events.HistorySync) {
	if event.Data == nil {
		return
	}
	onDemand := event.Data.GetSyncType() == waHistorySync.HistorySync_ON_DEMAND
	batch := historyBatch{OnDemand: onDemand, GroupIDs: make([]string, 0, len(event.Data.GetConversations())), Messages: make([]historyReference, 0)}
	type parsedMessage struct {
		event *events.Message
	}
	parsed := make([]parsedMessage, 0)
	for _, conversation := range event.Data.GetConversations() {
		chat, err := types.ParseJID(conversation.GetID())
		if err != nil {
			continue
		}
		batch.GroupIDs = append(batch.GroupIDs, chat.String())
		for _, historyMessage := range conversation.GetMessages() {
			if historyMessage.GetMessage() == nil {
				continue
			}
			message, parseErr := b.client.ParseWebMessage(chat, historyMessage.GetMessage())
			if parseErr != nil || message == nil {
				continue
			}
			parsed = append(parsed, parsedMessage{event: message})
			ref := historyReference{MessageTimestamp: message.Info.Timestamp.Unix()}
			ref.Key.RemoteJID = message.Info.Chat.String()
			ref.Key.ID = string(message.Info.ID)
			ref.Key.FromMe = message.Info.IsFromMe
			if message.Info.IsGroup && !message.Info.Sender.IsEmpty() {
				ref.Key.Participant = message.Info.Sender.String()
			}
			batch.Messages = append(batch.Messages, ref)
		}
	}
	if onDemand {
		protocolID := ""
		if event.Notification != nil {
			protocolID = event.Notification.GetPeerDataRequestSessionID()
		}
		batch.RequestID = b.matchHistoryRequest(protocolID, batch.GroupIDs, batch.Messages)
	}
	// Process older messages first so related supplier posts are captured in a
	// deterministic sequence, regardless of the event's wire ordering.
	sort.SliceStable(parsed, func(i, j int) bool {
		return parsed[i].event.Info.Timestamp.Before(parsed[j].event.Info.Timestamp)
	})
	_ = b.emit(envelope{Type: "event", Event: "history-batch", Batch: batch})
	for _, item := range parsed {
		b.emitMessage(item.event, "history")
	}
}

func (b *bridge) emitMessage(event *events.Message, messageType string) {
	if event == nil || event.Message == nil || event.Info.Chat.IsEmpty() || event.Info.ID == "" {
		return
	}
	timestamp := event.Info.Timestamp
	if messageType == "notify" && timestamp.IsZero() {
		timestamp = time.Now()
	}
	message := normalizeSupplierMessage(event.Message)
	if message == nil {
		return
	}
	text := message.GetConversation()
	if text == "" && message.GetExtendedTextMessage() != nil {
		text = message.GetExtendedTextMessage().GetText()
	}
	if text == "" && message.GetImageMessage() != nil {
		text = message.GetImageMessage().GetCaption()
	}
	if text == "" && message.GetVideoMessage() != nil {
		text = message.GetVideoMessage().GetCaption()
	}
	if text == "" && message.GetDocumentMessage() != nil {
		text = message.GetDocumentMessage().GetCaption()
	}
	groupID := event.Info.Chat.String()
	// Own messages may still provide a valid history cursor, but like the old
	// adapter they are never supplier input and should not trigger a media fetch.
	isSupplierGroup := !event.Info.IsFromMe && b.isSupplierGroup(groupID)
	if !isSupplierGroup {
		text = ""
	}
	payload := messagePayload{GroupID: groupID, MessageID: string(event.Info.ID), TimestampMs: timestamp.UnixMilli(), FromMe: event.Info.IsFromMe, Type: messageType, Text: text}
	if event.Info.IsGroup && !event.Info.Sender.IsEmpty() {
		payload.ParticipantID = event.Info.Sender.String()
	}
	if message.GetAlbumMessage() != nil {
		payload.ExpectedAlbumImages = int(message.GetAlbumMessage().GetExpectedImageCount())
	}

	var downloadable interface {
		whatsmeow.DownloadableMessage
		GetMimetype() string
		GetFileLength() uint64
	}
	if image := message.GetImageMessage(); image != nil {
		downloadable = image
	} else if document := message.GetDocumentMessage(); document != nil && isImageDocument(document.GetMimetype(), document.GetFileName()) {
		downloadable = document
	}
	if downloadable != nil {
		payload.MimeType = strings.ToLower(strings.Split(downloadable.GetMimetype(), ";")[0])
		if isSupplierGroup {
			ctx, cancel := context.WithTimeout(b.ctx, 90*time.Second)
			bytes, err := b.downloadMedia(ctx, event, downloadable)
			cancel()
			if err != nil {
				payload.MediaDownloadError = true
			} else {
				payload.ImageBase64 = base64.StdEncoding.EncodeToString(bytes)
			}
		}
	}
	_ = b.emit(envelope{Type: "event", Event: "message", Message: payload})
}

// Baileys normalizes up to five nested ephemeral, view-once, document-caption,
// and edit wrappers before the supplier logic inspects the message body.
func normalizeSupplierMessage(message *waE2E.Message) *waE2E.Message {
	for depth := 0; message != nil && depth < maxMessageWrapperDepth; depth++ {
		switch {
		case message.GetEphemeralMessage().GetMessage() != nil:
			message = message.GetEphemeralMessage().GetMessage()
		case message.GetViewOnceMessage().GetMessage() != nil:
			message = message.GetViewOnceMessage().GetMessage()
		case message.GetDocumentWithCaptionMessage().GetMessage() != nil:
			message = message.GetDocumentWithCaptionMessage().GetMessage()
		case message.GetViewOnceMessageV2().GetMessage() != nil:
			message = message.GetViewOnceMessageV2().GetMessage()
		case message.GetViewOnceMessageV2Extension().GetMessage() != nil:
			message = message.GetViewOnceMessageV2Extension().GetMessage()
		case message.GetEditedMessage().GetMessage() != nil:
			message = message.GetEditedMessage().GetMessage()
		default:
			return message
		}
	}
	return message
}

func (b *bridge) downloadMedia(ctx context.Context, event *events.Message, media interface {
	whatsmeow.DownloadableMessage
	GetMimetype() string
	GetFileLength() uint64
}) ([]byte, error) {
	if media.GetFileLength() > uint64(maxSupplierImageBytes) {
		return nil, errSupplierImageTooLarge
	}
	tempFile, err := os.CreateTemp(b.mediaTempDir, "supplier-image-*")
	if err != nil {
		return nil, fmt.Errorf("create temporary media file: %w", err)
	}
	defer func() {
		_ = tempFile.Close()
		_ = os.Remove(tempFile.Name())
	}()
	boundedFile := sizeLimitedMediaFile{File: tempFile, maxBytes: maxSupplierImageBytes + maxEncryptedImageOverhead}
	download := func() error {
		if err := boundedFile.Truncate(0); err != nil {
			return err
		}
		if _, err := boundedFile.Seek(0, io.SeekStart); err != nil {
			return err
		}
		return b.client.DownloadToFile(ctx, media, boundedFile)
	}

	err = download()
	if err == nil {
		return readSupplierImage(boundedFile)
	}
	if !isExpiredMediaError(err) || len(media.GetMediaKey()) == 0 {
		return nil, err
	}

	key := mediaRetryKey(event.Info)
	result := make(chan mediaRetryResult, 1)
	b.mediaRetryMu.Lock()
	if _, exists := b.pendingMedia[key]; exists {
		b.mediaRetryMu.Unlock()
		return nil, errors.New("a media re-upload request is already pending")
	}
	b.pendingMedia[key] = pendingMediaRetry{mediaKey: append([]byte(nil), media.GetMediaKey()...), result: result}
	b.mediaRetryMu.Unlock()

	retryCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err = b.client.SendMediaRetryReceipt(retryCtx, &event.Info, media.GetMediaKey()); err != nil {
		b.removePendingMedia(key)
		return nil, fmt.Errorf("media re-upload request failed: %w", err)
	}
	select {
	case retry := <-result:
		if retry.err != nil {
			return nil, retry.err
		}
		if err = setMediaDirectPath(media, retry.directPath); err != nil {
			return nil, err
		}
		if err = download(); err != nil {
			return nil, err
		}
		return readSupplierImage(boundedFile)
	case <-retryCtx.Done():
		b.removePendingMedia(key)
		return nil, fmt.Errorf("timed out waiting for media re-upload: %w", retryCtx.Err())
	}
}

func readSupplierImage(file interface {
	io.ReaderAt
	Stat() (os.FileInfo, error)
}) ([]byte, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect downloaded media: %w", err)
	}
	if info.Size() > maxSupplierImageBytes {
		return nil, errSupplierImageTooLarge
	}
	return io.ReadAll(io.NewSectionReader(file, 0, info.Size()))
}

func (b *bridge) handleMediaRetry(event *events.MediaRetry) {
	if event == nil {
		return
	}
	key := mediaRetryKey(types.MessageInfo{MessageSource: types.MessageSource{Chat: event.ChatID}, ID: event.MessageID})
	b.mediaRetryMu.Lock()
	pending, ok := b.pendingMedia[key]
	if ok {
		delete(b.pendingMedia, key)
	}
	b.mediaRetryMu.Unlock()
	if !ok {
		return
	}
	notification, err := whatsmeow.DecryptMediaRetryNotification(event, pending.mediaKey)
	if err != nil {
		pending.result <- mediaRetryResult{err: fmt.Errorf("failed to decrypt media re-upload response: %w", err)}
		return
	}
	if notification.GetResult() != waMmsRetry.MediaRetryNotification_SUCCESS || notification.GetDirectPath() == "" {
		pending.result <- mediaRetryResult{err: errors.New("WhatsApp could not re-upload the expired media")}
		return
	}
	pending.result <- mediaRetryResult{directPath: notification.GetDirectPath()}
}

func (b *bridge) removePendingMedia(key string) {
	b.mediaRetryMu.Lock()
	delete(b.pendingMedia, key)
	b.mediaRetryMu.Unlock()
}

func mediaRetryKey(info types.MessageInfo) string {
	return info.Chat.String() + "\x00" + string(info.ID)
}

func isExpiredMediaError(err error) bool {
	return errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith403) ||
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith404) ||
		errors.Is(err, whatsmeow.ErrMediaDownloadFailedWith410)
}

func setMediaDirectPath(media whatsmeow.DownloadableMessage, directPath string) error {
	if directPath == "" {
		return errors.New("WhatsApp returned an empty re-upload path")
	}
	switch message := media.(type) {
	case *waE2E.ImageMessage:
		message.DirectPath = proto.String(directPath)
	case *waE2E.DocumentMessage:
		message.DirectPath = proto.String(directPath)
	default:
		return fmt.Errorf("unsupported media type for re-upload: %T", media)
	}
	return nil
}

func isImageDocument(mimeType, fileName string) bool {
	if strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		return true
	}
	switch strings.ToLower(filepath.Ext(fileName)) {
	case ".jpg", ".jpeg", ".png", ".webp", ".gif":
		return true
	default:
		return false
	}
}

func (b *bridge) requestHistory(ctx context.Context, cmd command) error {
	if cmd.RequestID == "" {
		return errors.New("incomplete history anchor")
	}
	if b.client.Store.ID == nil {
		return whatsmeow.ErrNotLoggedIn
	}
	request, err := BuildHistoryRequest(b.client, cmd.GroupID, cmd.MessageID, cmd.TimestampSec, cmd.FromMe)
	if err != nil {
		return err
	}
	protocolID := b.client.GenerateMessageID()
	b.appendPendingHistory(pendingHistoryRequest{
		requestID: cmd.RequestID, protocolID: string(protocolID), attemptID: cmd.AttemptID,
		groupID: cmd.GroupID, messageID: cmd.MessageID, timestampSec: cmd.TimestampSec, requestedAt: time.Now(),
	})
	_, err = b.client.SendMessage(ctx, b.client.Store.ID.ToNonAD(), request, whatsmeow.SendRequestExtra{
		ID: protocolID, Peer: true, Timeout: historyRequestAckTimeout,
	})
	if err != nil {
		b.historyMu.Lock()
		for i, pending := range b.pendingHistory {
			if pending.requestID == cmd.RequestID {
				b.pendingHistory = append(b.pendingHistory[:i], b.pendingHistory[i+1:]...)
				break
			}
		}
		b.historyMu.Unlock()
	}
	return err
}

func (b *bridge) matchHistoryRequest(protocolID string, groupIDs []string, messages []historyReference) string {
	b.historyMu.Lock()
	defer b.historyMu.Unlock()
	b.prunePendingHistory(time.Now())
	if protocolID != "" {
		for _, pending := range b.pendingHistory {
			if pending.protocolID == protocolID {
				b.removePendingHistoryCursor(pending)
				return pending.requestID
			}
		}
		return ""
	}
	for _, groupID := range groupIDs {
		var latestMessageTimestamp int64
		for _, message := range messages {
			if message.Key.RemoteJID == groupID && message.MessageTimestamp > latestMessageTimestamp {
				latestMessageTimestamp = message.MessageTimestamp
			}
		}

		matchIndex := -1
		if latestMessageTimestamp > 0 {
			// An on-demand page contains messages immediately before its anchor.
			// Choose the closest pending anchor that is still newer than the page.
			// This prevents a late response for page N from consuming page N+1.
			ambiguous := false
			for i, pending := range b.pendingHistory {
				if pending.groupID != groupID || pending.timestampSec < latestMessageTimestamp {
					continue
				}
				if matchIndex == -1 || pending.timestampSec < b.pendingHistory[matchIndex].timestampSec {
					matchIndex = i
					ambiguous = false
				} else if pending.timestampSec == b.pendingHistory[matchIndex].timestampSec &&
					(pending.messageID != b.pendingHistory[matchIndex].messageID || pending.attemptID != b.pendingHistory[matchIndex].attemptID) {
					ambiguous = true
				}
			}
			if ambiguous {
				matchIndex = -1
			}
		} else {
			// Empty responses have no message timestamps. They can be matched by
			// group only when all outstanding entries for that group are retries
			// of one cursor; otherwise the response is ambiguous.
			cursorID := ""
			cursorTimestamp := int64(0)
			cursorAttempt := int64(0)
			ambiguous := false
			for i, pending := range b.pendingHistory {
				if pending.groupID != groupID {
					continue
				}
				if matchIndex == -1 {
					matchIndex = i
					cursorID = pending.messageID
					cursorTimestamp = pending.timestampSec
					cursorAttempt = pending.attemptID
				} else if pending.messageID != cursorID || pending.timestampSec != cursorTimestamp || pending.attemptID != cursorAttempt {
					ambiguous = true
					break
				}
			}
			if ambiguous {
				matchIndex = -1
			}
		}
		if matchIndex >= 0 {
			matched := b.pendingHistory[matchIndex]
			b.removePendingHistoryCursor(matched)
			return matched.requestID
		}
	}
	// HistorySync may omit conversations for an empty response. Match only when
	// every outstanding entry represents retries of the same cursor.
	if len(groupIDs) == 0 && len(b.pendingHistory) > 0 {
		first := b.pendingHistory[0]
		for _, pending := range b.pendingHistory[1:] {
			if pending.attemptID != first.attemptID || pending.groupID != first.groupID || pending.messageID != first.messageID || pending.timestampSec != first.timestampSec {
				return ""
			}
		}
		b.removePendingHistoryCursor(first)
		return first.requestID
	}
	return ""
}

func (b *bridge) appendPendingHistory(request pendingHistoryRequest) {
	b.historyMu.Lock()
	defer b.historyMu.Unlock()
	b.prunePendingHistory(time.Now())
	b.pendingHistory = append(b.pendingHistory, request)
	if excess := len(b.pendingHistory) - maxPendingHistoryCorrelations; excess > 0 {
		copy(b.pendingHistory, b.pendingHistory[excess:])
		b.pendingHistory = b.pendingHistory[:len(b.pendingHistory)-excess]
	}
}

// Keep unmatched requests long enough to correlate delayed WhatsApp history,
// while preventing a long-running bridge from accumulating them forever.
func (b *bridge) prunePendingHistory(now time.Time) {
	cutoff := now.Add(-historyCorrelationTTL)
	remaining := b.pendingHistory[:0]
	for _, pending := range b.pendingHistory {
		if pending.requestedAt.IsZero() || !pending.requestedAt.Before(cutoff) {
			remaining = append(remaining, pending)
		}
	}
	b.pendingHistory = remaining
}

func (b *bridge) removePendingHistoryCursor(cursor pendingHistoryRequest) {
	remaining := b.pendingHistory[:0]
	for _, pending := range b.pendingHistory {
		if pending.attemptID != cursor.attemptID || pending.groupID != cursor.groupID || pending.messageID != cursor.messageID || pending.timestampSec != cursor.timestampSec {
			remaining = append(remaining, pending)
		}
	}
	b.pendingHistory = remaining
}

func (b *bridge) sendImage(ctx context.Context, cmd command) (string, error) {
	chat, err := types.ParseJID(cmd.GroupID)
	if err != nil || chat.Server != types.GroupServer {
		return "", errors.New("invalid target group")
	}
	image, err := base64.StdEncoding.DecodeString(cmd.ImageBase64)
	if err != nil || len(image) == 0 {
		return "", errors.New("invalid image payload")
	}
	upload, err := b.client.Upload(ctx, image, whatsmeow.MediaImage)
	if err != nil {
		return "", fmt.Errorf("media upload failed: %w", err)
	}
	imageMessage := &waE2E.ImageMessage{
		URL:           proto.String(upload.URL),
		DirectPath:    proto.String(upload.DirectPath),
		MediaKey:      upload.MediaKey,
		FileEncSHA256: upload.FileEncSHA256,
		FileSHA256:    upload.FileSHA256,
		FileLength:    proto.Uint64(upload.FileLength),
		Mimetype:      proto.String(cmd.MimeType),
		Caption:       proto.String(cmd.Caption),
	}
	response, err := b.client.SendMessage(ctx, chat, &waE2E.Message{ImageMessage: imageMessage})
	if err != nil {
		return "", fmt.Errorf("image send failed: %w", err)
	}
	return string(response.ID), nil
}

func (b *bridge) emit(output envelope) error {
	b.outputMu.Lock()
	defer b.outputMu.Unlock()
	return b.output.Encode(output)
}

func (b *bridge) close() {
	b.cancel()
	if b.client != nil {
		b.client.Disconnect()
	}
	if b.container != nil {
		_ = b.container.Close()
	} else if b.db != nil {
		_ = b.db.Close()
	}
}

func safeError(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func isRetryableConnectError(err error) bool {
	if err == nil {
		return false
	}
	var networkError net.Error
	if errors.As(err, &networkError) {
		return true
	}
	var statusErr socket.ErrWithStatusCode
	if errors.As(err, &statusErr) {
		return isRetryableConnectStatusCode(statusErr.StatusCode)
	}
	return errors.Is(err, socket.ErrDialFailed)
}

func isRetryableConnectStatusCode(status int) bool {
	switch status {
	case 408, 500, 501, 502, 503, 504:
		return true
	default:
		return false
	}
}

func BuildHistoryRequest(client *whatsmeow.Client, groupID, messageID string, timestampSeconds int64, fromMe bool) (*waE2E.Message, error) {
	group, err := types.ParseJID(groupID)
	if err != nil || group.Server != types.GroupServer || messageID == "" || timestampSeconds <= 0 {
		return nil, errors.New("invalid history cursor")
	}
	return client.BuildHistorySyncRequest(&types.MessageInfo{
		MessageSource: types.MessageSource{Chat: group, IsFromMe: fromMe, IsGroup: true},
		ID:            types.MessageID(messageID),
		Timestamp:     time.Unix(timestampSeconds, 0),
	}, 50), nil
}
