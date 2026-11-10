import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch
from PIL import Image
import identificar_marcas as marcas


def test_catalogo_filtra_archivos_y_ordena(tmp_path):
    (tmp_path / 'Nike').mkdir(); (tmp_path / 'Adidas').mkdir()
    for nombre in ['Nike/a.JPG', 'Nike/b.txt', 'Adidas/a.webp']:
        (tmp_path / nombre).write_bytes(b'x')
    assert [(marca, ruta.name) for marca, ruta in marcas.catalogo_directorio(tmp_path)] == [('Adidas', 'a.webp'), ('Nike', 'a.JPG')]


def test_catalogo_inexistente_y_vacio(tmp_path):
    with pytest.raises(ValueError, match='no existe'): marcas.catalogo_directorio(tmp_path / 'nada')
    with pytest.raises(ValueError, match='vacío'): marcas.catalogo_directorio(tmp_path)


def test_base_datos_solo_lectura(tmp_path):
    import sqlite3
    db = tmp_path / 'business.sqlite'
    with sqlite3.connect(db) as c:
        c.executescript('''CREATE TABLE shoe_brand_registry(normalized_name TEXT,display_name TEXT);
        CREATE TABLE shoe_brand_references(normalized_brand TEXT,media_asset_id TEXT);
        CREATE TABLE media_assets(id TEXT,file_name TEXT);
        INSERT INTO shoe_brand_registry VALUES ('nike','Nike');
        INSERT INTO shoe_brand_references VALUES ('nike','a');
        INSERT INTO media_assets VALUES ('a','foto.jpg');''')
    assert marcas.catalogo_base_datos(db) == [('Nike', tmp_path / 'media' / 'foto.jpg')]


def test_embeddings_normalizacion_y_compatibilidad():
    v = torch.tensor([[3., 4.], [0., 2.]])
    assert torch.allclose(marcas.normalizar(v).norm(dim=1), torch.ones(2))
    assert marcas.extraer_tensor(v) is v
    assert marcas.extraer_tensor(SimpleNamespace(pooler_output=v)) is v
    with pytest.raises(ValueError): marcas.normalizar(torch.zeros((1, 2)))
    with pytest.raises(ValueError): marcas.extraer_tensor(SimpleNamespace(pooler_output=None))


def test_ranking_top_tres_y_desempate():
    consulta = torch.tensor([1., 0.])
    refs = torch.tensor([[0.9, 0.], [0.8, 0.], [0.7, 0.], [-1., 0.], [0.8, 0.]])
    resultado = marcas.ranking_marcas(consulta, refs, ['Nike', 'Nike', 'Nike', 'Nike', 'Adidas'])
    assert [r['marca'] for r in resultado] == ['Adidas', 'Nike']
    assert resultado[1]['similitud'] == pytest.approx(0.8)


def test_imagen_corrupta_y_dispositivo_inexistente(tmp_path):
    archivo = tmp_path / 'mal.jpg'; archivo.write_text('no es imagen')
    with pytest.raises(Exception): marcas.cargar_imagen(archivo)
    falso = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)))
    with pytest.raises(ValueError, match='no está disponible'): marcas.seleccionar_dispositivo('cuda', falso)
    assert marcas.seleccionar_dispositivo('auto', falso) == 'cpu'


def test_json_y_umbral(monkeypatch, tmp_path, capsys):
    (tmp_path / 'Nike').mkdir(); (tmp_path / 'Nike' / 'a.jpg').touch()
    monkeypatch.setattr(marcas, 'inferir', lambda *args: ([{'marca': 'Nike', 'similitud': 0.5}], [], 'cpu'))
    assert marcas.main(['foto.jpg', '--referencias', str(tmp_path), '--json']) == 0
    assert json.loads(capsys.readouterr().out)['marca_estimada'] == 'Nike'
    assert marcas.main(['foto.jpg', '--referencias', str(tmp_path), '--json', '--umbral', '0.6']) == 0
    assert json.loads(capsys.readouterr().out)['marca_estimada'] == 'Desconocida'


def test_sin_referencias_validas(monkeypatch, tmp_path, capsys):
    (tmp_path / 'Nike').mkdir(); (tmp_path / 'Nike' / 'mala.jpg').touch()
    monkeypatch.setattr(marcas, 'inferir', lambda *args: (_ for _ in ()).throw(ValueError('No quedan referencias válidas')))
    assert marcas.main(['foto.jpg', '--referencias', str(tmp_path)]) == 1
    assert 'No quedan referencias válidas' in capsys.readouterr().err
