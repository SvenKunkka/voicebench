# Changelog

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
