Reference clips for Qwen3-TTS voice cloning: `<name>.flac` (24 kHz mono, 5–10 s) plus `<name>.txt` (its exact transcript).
The server loads every pair in this folder at startup; `TTS_VOICE_DE` / `TTS_VOICE_EN` pick the defaults.

All voices here are **synthetic**: generated with
[Qwen3-TTS-12Hz-1.7B-VoiceDesign](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign) from a text description,
not recorded from a real person.

- `design-m` (German default): "Male voice. A calm, friendly German man in his mid thirties with a low, warm baritone.
  Clear standard High German without any accent, relaxed natural pace, like a colleague on the phone." Median F0 ≈ 108 Hz.
- `design-m2`: same description, a lighter take (≈ 137 Hz).
- `design-f`: same description, female.
- `en-m` (English default): "Male voice. A calm, friendly American man in his mid thirties with a warm baritone. Clear
  General American accent …" (≈ 100 Hz).

## Making your own voice

1. Generate a clip with the VoiceDesign model (see its model card): give it a voice description plus a sentence or two
   to read, and save the result as 24 kHz mono FLAC. Tip: write the description in English and start it with
   "Male voice." / "Female voice."; a description in German once came out with the wrong gender. Check the pitch.
2. Save the sentence it read, verbatim, as `<name>.txt` next to `<name>.flac`.
3. Rebuild the image (or mount this folder at `/voices`) and select it with `TTS_VOICE_DE` / `TTS_VOICE_EN`, or per
   request with Yapper's `YAP_GPU_VOICE` / `YAP_GPU_VOICE_DE` / `YAP_GPU_VOICE_EN`.

Only clone a real person's voice with their consent and within the license of the recording.
