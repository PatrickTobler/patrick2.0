---
name: fal-ai
description: Generate images, video, voice, and audio via fal.ai's 600+ generative media models. Use when Patrick asks for image generation, video generation, image-to-image transformation, voice synthesis, or any "make me a picture/video/audio of X" task. Auth via FAL_KEY env var (already set on Railway).
---

# fal.ai - Generative AI Models

## Auth
The `FAL_KEY` env var is already set in this environment. Do NOT print it. Pass it as a header to every fal.ai API call.

## When to use
- Generating images from text prompts
- Image-to-image transformations
- Video generation (text-to-video, image-to-video)
- Audio/voice generation
- Music generation
- Upscaling, background removal, inpainting

## API basics

Base URL: `https://fal.run`
Auth header: `Authorization: Key $FAL_KEY`

### Submit a job (synchronous, fast models)
```bash
curl -X POST https://fal.run/fal-ai/flux/dev \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a serene mountain lake at sunset, cinematic"}'
```

Response includes `images: [{url, width, height}]`.

### Submit a job (queued, slow models)
```bash
# 1. Submit
curl -X POST https://queue.fal.run/fal-ai/veo3 \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "..."}'
# returns: {request_id, status_url, response_url}

# 2. Poll status_url until status = COMPLETED
# 3. Fetch response_url for the result
```

## Common model endpoints

### Image
- `fal-ai/flux/dev` — text-to-image, fast quality (default pick)
- `fal-ai/flux/schnell` — text-to-image, fastest
- `fal-ai/flux-pro/v1.1-ultra` — text-to-image, best quality
- `fal-ai/flux/dev/image-to-image` — img2img with text guidance
- `fal-ai/recraft-v3` — vector-style + branded design
- `fal-ai/imagen4` — Google's Imagen
- `fal-ai/nano-banana` — fast cheap text-to-image

### Video
- `fal-ai/veo3` — Google Veo 3, text-to-video
- `fal-ai/kling-video/v2/master/text-to-video` — Kling 2
- `fal-ai/wan-2.5/text-to-video` — Wan 2.5

### Audio / Voice
- `fal-ai/elevenlabs/tts/multilingual-v2` — ElevenLabs TTS
- `fal-ai/playai/tts/v3` — PlayAI TTS
- `fal-ai/stable-audio-25/text-to-audio` — music

## Output handling
Each response gives back URLs hosted by fal.ai (CDN). For Telegram delivery, just send the URL — Telegram's inline preview renders the image/video.

## Cost awareness
fal.ai is pay-per-use. Image generation typically $0.003–$0.05 per image. Video and high-end models cost more. Don't generate without a clear ask from Patrick.
