#!/usr/bin/env python3
"""
Wrapper de transcrição local para o Kassinão (TRANSCRIBE_PROVIDER=command).

Uso: python3 transcribe-local.py [--model MODEL] [--language LANG] <input.mp3> <output.json>
Instalação: a imagem publicada não traz Python; compile a sua com
`docker build --build-arg LOCAL_TRANSCRIBE=1 .` (requirements-whisper.txt, hashes fixos).

O Kassinão chama este script uma vez por pedaço de áudio (mono, 16 kHz) e
espera encontrar em <output.json> um array [{"start": s, "end": s, "text": "..."}].

O comando local recebe um ambiente mínimo: variáveis como WHISPER_MODEL e
TRANSCRIBE_LANGUAGE só chegam aqui se constarem em TRANSCRIBE_COMMAND_ENV_ALLOWLIST.
Por isso o jeito recomendado é passar modelo e idioma por argumento:
    TRANSCRIBE_COMMAND=python3 ./scripts/transcribe-local.py --model small --language pt {input} {output}

Troque o modelo conforme a máquina: "small" roda bem em CPU comum;
"medium"/"large-v3" são melhores com mais RAM/GPU. Para NVIDIA Parakeet ou
whisper.cpp, escreva um wrapper equivalente que produza o mesmo JSON.
"""
import argparse
import json
import os
import sys

from faster_whisper import WhisperModel


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcrição local (faster-whisper) para o Kassinão")
    parser.add_argument("--model", default=os.environ.get("WHISPER_MODEL", "small"))
    # O padrão do app (TRANSCRIBE_LANGUAGE) é "en"; aqui o mesmo, para os dois não divergirem em silêncio.
    parser.add_argument("--language", default=os.environ.get("TRANSCRIBE_LANGUAGE", "en"))
    parser.add_argument("input_path")
    parser.add_argument("output_path")
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args(sys.argv[1:])
    language = args.language.split("-")[0].lower()  # "pt-BR" -> "pt"
    model = WhisperModel(args.model, device="auto", compute_type="int8")
    segments, _info = model.transcribe(args.input_path, language=language, vad_filter=True)
    result = [{"start": seg.start, "end": seg.end, "text": seg.text.strip()} for seg in segments]
    with open(args.output_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)


if __name__ == "__main__":
    main()
