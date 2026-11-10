#!/usr/bin/env python3
"""Estimar marcas de calzado comparando fotos locales con SigLIP 2."""
import argparse
import hashlib
import json
import math
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

MODELO = 'google/siglip2-base-patch16-224'
EXTENSIONES = {'.jpg', '.jpeg', '.png', '.webp'}


def catalogo_directorio(directorio):
    raiz = Path(directorio)
    if not raiz.is_dir():
        raise ValueError(f'El directorio de referencias no existe: {raiz}')
    fotos = [(marca.name, foto) for marca in sorted(raiz.iterdir()) if marca.is_dir()
             for foto in sorted(marca.iterdir()) if foto.is_file() and foto.suffix.lower() in EXTENSIONES]
    if not fotos:
        raise ValueError('El catálogo de referencias está vacío o no contiene imágenes compatibles.')
    return fotos


def catalogo_base_datos(ruta):
    base = Path(ruta).resolve()
    if not base.is_file():
        raise ValueError(f'La base de datos no existe: {base}')
    try:
        with sqlite3.connect(base.as_uri() + '?mode=ro', uri=True) as conexion:
            filas = conexion.execute('''SELECT b.display_name, m.file_name FROM shoe_brand_references r
                JOIN shoe_brand_registry b ON b.normalized_name=r.normalized_brand
                JOIN media_assets m ON m.id=r.media_asset_id ORDER BY b.display_name,m.file_name''').fetchall()
    except sqlite3.Error as error:
        raise ValueError(f'No se pudo leer el catálogo de la aplicación: {error}') from error
    raiz = (base.parent / 'media').resolve()
    fotos = [(marca, raiz / nombre) for marca, nombre in filas
             if Path(nombre).name == nombre and Path(nombre).suffix.lower() in EXTENSIONES]
    if not fotos:
        raise ValueError('La base de datos no contiene referencias de imagen compatibles.')
    return fotos


def ranking_marcas(consulta, referencias, marcas):
    """Las filas deben estar normalizadas; cada marca usa sus tres mejores fotos."""
    if len(referencias) != len(marcas) or not marcas:
        raise ValueError('Las referencias y marcas deben tener el mismo tamaño y no estar vacías.')
    scores = (referencias @ consulta.reshape(-1)).tolist()
    agrupadas = defaultdict(list)
    for marca, score in zip(marcas, scores):
        agrupadas[marca].append(float(score))
    resultados = [{'marca': marca, 'similitud': sum(top) / len(top)} for marca, valores in agrupadas.items()
                  for top in [sorted(valores, reverse=True)[:3]]]
    return sorted(resultados, key=lambda item: (-item['similitud'], item['marca'].casefold(), item['marca']))


def extraer_tensor(salida):
    # Transformers devuelve tensor en unas versiones y BaseModelOutput en otras.
    if hasattr(salida, 'pooler_output'):
        salida = salida.pooler_output
    if salida is None or not hasattr(salida, 'ndim') or salida.ndim != 2:
        raise ValueError('El modelo devolvió embeddings visuales incompatibles.')
    return salida


def normalizar(tensor):
    import torch
    if tensor.ndim != 2 or not torch.isfinite(tensor).all():
        raise ValueError('Los embeddings deben ser una matriz finita.')
    normas = torch.linalg.vector_norm(tensor, dim=-1, keepdim=True)
    if (normas == 0).any():
        raise ValueError('El modelo devolvió un embedding vacío.')
    return tensor / normas


def seleccionar_dispositivo(solicitado, torch):
    disponibles = {'cpu': True, 'cuda': torch.cuda.is_available(),
                    'mps': bool(getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available())}
    if solicitado == 'auto':
        return next(d for d in ('cuda', 'mps', 'cpu') if disponibles[d])
    if not disponibles[solicitado]:
        raise ValueError(f'El dispositivo {solicitado} no está disponible en este equipo.')
    return solicitado


def cargar_imagen(ruta):
    from PIL import Image, ImageOps
    with Image.open(ruta) as original:
        original = ImageOps.exif_transpose(original)
        if original.width * original.height > 50_000_000:
            raise ValueError('imagen demasiado grande (más de 50 megapíxeles)')
        return original.convert('RGB')


def inferir(ruta, fotos, dispositivo='auto', lote=8):
    try:
        import torch
        from transformers import AutoModel, AutoProcessor
    except ImportError as error:
        raise ValueError('Faltan dependencias. Instálalas con pip install -r requirements_marcas.txt.') from error
    dispositivo = seleccionar_dispositivo(dispositivo, torch)
    consulta = Path(ruta)
    if not consulta.is_file() or consulta.suffix.lower() not in EXTENSIONES:
        raise ValueError(f'La imagen de consulta no existe o no es JPEG, PNG o WebP: {consulta}')
    try:
        imagen_consulta = cargar_imagen(consulta)
    except Exception as error:
        raise ValueError(f'No se pudo leer la imagen de consulta: {error}') from error
    # Una copia idéntica de la consulta no debe aparecer como evidencia a su favor.
    huella = hashlib.sha256(consulta.read_bytes()).digest()
    procesador = AutoProcessor.from_pretrained(MODELO)
    modelo = AutoModel.from_pretrained(MODELO).to(dispositivo).eval()
    def embeddings(imagenes):
        entrada = procesador(images=imagenes, return_tensors='pt').to(dispositivo)
        with torch.inference_mode():
            return normalizar(extraer_tensor(modelo.get_image_features(**entrada))).cpu()
    consulta_embedding = embeddings([imagen_consulta])[0]
    imagen_consulta.close()
    vectores, marcas, advertencias = [], [], []
    for inicio in range(0, len(fotos), lote):
        imagenes, nombres = [], []
        for marca, archivo in fotos[inicio:inicio+lote]:
            try:
                if hashlib.sha256(archivo.read_bytes()).digest() == huella:
                    continue
                imagenes.append(cargar_imagen(archivo)); nombres.append(marca)
            except (OSError, ValueError) as error:
                advertencias.append(f'{archivo}: {error}')
        if imagenes:
            try:
                vectores.append(embeddings(imagenes)); marcas.extend(nombres)
            finally:
                for imagen in imagenes: imagen.close()
    if not vectores:
        raise ValueError('No quedan referencias válidas distintas de la foto consultada.')
    return ranking_marcas(consulta_embedding, torch.cat(vectores), marcas), advertencias, dispositivo


def construir_parser():
    parser = argparse.ArgumentParser(description='Estima marcas por similitud visual local; no identifica necesariamente logotipos y la similitud no es una probabilidad.')
    parser.add_argument('foto', help='Imagen JPEG, PNG o WebP')
    grupo = parser.add_mutually_exclusive_group()
    grupo.add_argument('--referencias', help='Directorio con una subcarpeta por marca (por defecto: referencias)')
    grupo.add_argument('--base-de-datos', help='Base business.sqlite de la aplicación para usar sus referencias locales')
    parser.add_argument('--top-k', type=int, default=5, help='Número máximo de marcas a mostrar')
    parser.add_argument('--umbral', type=float, help='Umbral opcional de similitud coseno; debe calibrarse con datos propios')
    parser.add_argument('--device', choices=['auto', 'cpu', 'cuda', 'mps'], default='auto')
    parser.add_argument('--lote', type=int, default=8, help='Número de imágenes procesadas a la vez')
    parser.add_argument('--json', action='store_true', help='Emitir resultado JSON')
    return parser


def main(argv=None):
    parser = construir_parser(); args = parser.parse_args(argv)
    if args.top_k < 1 or args.lote < 1:
        parser.error('--top-k y --lote deben ser mayores que cero')
    if args.umbral is not None and (not math.isfinite(args.umbral) or not -1 <= args.umbral <= 1):
        parser.error('--umbral debe estar entre -1 y 1')
    try:
        fotos = catalogo_base_datos(args.base_de_datos) if args.base_de_datos else catalogo_directorio(args.referencias or 'referencias')
        ranking, advertencias, dispositivo = inferir(args.foto, fotos, args.device, args.lote)
        desconocida = args.umbral is not None and ranking[0]['similitud'] < args.umbral
        resultado = {'marca_estimada': 'Desconocida' if desconocida else ranking[0]['marca'], 'desconocida': desconocida,
                     'modelo': MODELO, 'metrica': 'similitud_coseno', 'dispositivo': dispositivo,
                     'ranking': ranking[:args.top_k], 'advertencias': advertencias}
        if args.json:
            print(json.dumps(resultado, ensure_ascii=False))
        else:
            print('Marca estimada:', resultado['marca_estimada'])
            print('Similitud coseno (no es probabilidad):')
            for item in resultado['ranking']: print(f"  {item['marca']}: {item['similitud']:.4f}")
            for aviso in advertencias: print(f'Advertencia: {aviso}', file=sys.stderr)
        return 0
    except Exception as error:
        texto = str(error)
        if 'out of memory' in texto.lower(): texto = 'Memoria insuficiente; reduce --lote o usa --device cpu.'
        print(f'Error: {texto}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
