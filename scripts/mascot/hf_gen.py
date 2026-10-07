#!/usr/bin/env python3
"""Generate mascot art on Hugging Face Spaces (ZeroGPU) and keep provenance.

Usage: hf_gen.py <model> <out.png> <prompt-file> [seed]

Models: zimage | schnell | flux | kolors | sd35turbo
Every run writes <out>.json with the model, prompt and seed actually used.
"""
from __future__ import annotations
import json, pathlib, sys, time
from gradio_client import Client

MODELS = {
    "zimage": ("Tongyi-MAI/Z-Image-Turbo", "/generate"),
    "schnell": ("black-forest-labs/FLUX.1-schnell", "/infer"),
    "flux": ("black-forest-labs/FLUX.1-dev", "/infer"),
    "kolors": ("Kwai-Kolors/Kolors", "/infer"),
    "sd35turbo": ("stabilityai/stable-diffusion-3.5-large-turbo", "/infer"),
}

def first_image(result):
    """Pull a filepath out of whatever shape the Space returns."""
    if isinstance(result, dict):
        return result.get("path") or result.get("url")
    if isinstance(result, (list, tuple)) and result:
        for item in result:
            p = first_image(item)
            if p:
                return p
    return None

def main() -> int:
    model_key, out, prompt_file = sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 42
    space, api = MODELS[model_key]
    prompt = prompt_file.read_text().strip()
    client = Client(space, verbose=False)
    if model_key == "zimage":
        res, used, _ = client.predict(prompt=prompt, resolution="1024x1024 ( 1:1 )", seed=seed,
                                      steps=8, shift=3.0, random_seed=True, gallery_images=[],
                                      api_name=api)
    elif model_key == "schnell":
        res, used = client.predict(prompt=prompt, seed=seed, randomize_seed=True,
                                   width=1024, height=1024, num_inference_steps=4, api_name=api)
    else:
        res, used = client.predict(prompt=prompt, seed=seed, randomize_seed=True,
                                   width=1024, height=1024, num_inference_steps=28,
                                   guidance_scale=3.5, api_name=api)
    src = first_image(res)
    if not src:
        print("no image in response", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    if str(src).startswith("http"):
        import urllib.request
        with urllib.request.urlopen(src, timeout=60) as r:
            out.write_bytes(r.read())
    else:
        out.write_bytes(pathlib.Path(src).read_bytes())
    out.with_suffix(".json").write_text(json.dumps(
        {"space": space, "api": api, "seed": used, "prompt": prompt}, indent=2))
    print(f"saved {out} ({out.stat().st_size // 1024} KB) from {space} seed={used}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
