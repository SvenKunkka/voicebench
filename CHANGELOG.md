# Changelog

## 1.3.0 — 2026-11-13

### Added

- Integrate the MIT-licensed Vibe Recorder and browser recording library, pinned
  to `SvenKunkka/vibe-recorder@edf13089a6df745b23613e52d9c6c929114cba41`, with its
  original license retained in `app/static/recorder/LICENSE`.
- Default `#record` workspace and same-page `#compare` analysis tab. Current takes
  and up to 20 selected historical takes pass as local `Blob` objects, without
  downloading and reimporting; library originals are retained.
- Default-input microphone capture without a fixed device ID, independent
  post-commit recording reads, and guards for recording/saving/unsaved only copies.
- JavaScript recorder integration and PCM/WAV regression suites in CI.

### Changed

- Use `127.0.0.1:8771` as the primary entry and keep `8767` as an alias, served by
  one process and one analysis worker. The launcher and `scripts/serve.py` use
  fixed ports and report conflicts instead of changing origins or stopping old services.
- Retain the `vibe-personal-recordings` IndexedDB name and show an origin reminder
  from the old analysis address. Browser profiles and origins remain isolated;
  there is no automatic recording migration.
- Document separate storage: browser library originals and local `data/jobs/`
  analysis copies, neither distributed with the source.
- Check library takes against the analysis limits before handoff: capture can
  last 30 minutes, while each analysis input remains limited to 10 minutes and 100 MB.

### Validation scope

- macOS remains the primary tested desktop environment. Automated recorder
  tests use simulated browser/audio environments and do not prove real microphone,
  permission or long-session hardware behavior.
- Existing speech scoring and localization limits from 1.2.0 remain applicable.

## 1.2.0 — 2026-11-13

First public source release.

### Added

- Local recording comparison with optional reference transcripts.
- Independent Whisper small transcription, CER and position-aligned keyword checks.
- DNSMOS P.835 speech, background and overall quality predictions.
- Original-level LUFS, true peak and conservative signal diagnostics.
- Clickable word/group timestamps, character positions and review candidates.
- Separate acoustic candidates and uncertain transcription with precision limits.
- Scenario grouping, repeated-recording summaries, persistent jobs and reanalysis.
- Standalone HTML, score CSV, localization CSV and full JSON exports.
- Chinese and English documentation, model provenance and third-party notices.

### Limitations

- Model predictions are not human intelligibility measurements.
- Overall MOS is not causally apportioned as per-character deductions.
- Different scripts or uncontrolled conditions cannot establish a hardware winner.
- macOS is the primary tested environment; other platforms need separate validation.
