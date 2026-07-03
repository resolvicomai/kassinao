#!/usr/bin/env python3
"""
Wrapper de transcrição local para o Kassinão (TRANSCRIBE_PROVIDER=command).

Uso: python3 transcribe-local.py <input.mp3> <output.json>
Instalação: pip install faster-whisper

O Kassinão chama este script uma vez por pedaço de áudio (mono, 16 kHz) e
espera encontrar em <output.json> um array [{"start": s, "end": s, "text": "..."}].

Troque o modelo conforme a máquina: "small" roda bem em CPU comum;
"medium"/"large-v3" são melhores com mais RAM/GPU. Para NVIDIA Parakeet ou
whisper.cpp, escreva um wrapper equivalente que produza o mesmo JSON.
"""
import json
import os
import sys

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("TRANSCRIBE_LANGUAGE", "pt")

def main() -> None:
    input_path, output_path = sys.argv[1], sys.argv[2]
    model = WhisperModel(MODEL, device="auto", compute_type="int8")
    segments, _info = model.transcribe(input_path, language=LANGUAGE, vad_filter=True)
    result = [{"start": seg.start, "end": seg.end, "text": seg.text.strip()} for seg in segments]
    with open(output_path, "w", encoding="utf-8") as fh:
        json.dump(result, fh, ensure_ascii=False)

if __name__ == "__main__":
    main()
