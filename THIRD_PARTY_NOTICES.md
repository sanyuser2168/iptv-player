# Сторонние компоненты

## FFmpeg

`bin/ffmpeg.exe` — сборка **FFmpeg essentials** с сайта https://www.gyan.dev/ffmpeg/builds/
(лицензия GPL v3, так как включает libx264).

FFmpeg используется как отдельный процесс для перекодирования потоков, кодек
которых не поддерживается Chromium (HEVC/H.265, MPEG-2, AC-3 и т. п.).
Исходный код FFmpeg: https://ffmpeg.org/download.html
Условия лицензии: https://www.gnu.org/licenses/gpl-3.0.html

Приложение запускает `ffmpeg.exe` как внешний процесс и не изменяет его.

## hls.js

https://github.com/video-dev/hls.js — Apache License 2.0.
Файл: `vendor/hls.min.js`.

## mpegts.js

https://github.com/xqq/mpegts.js — Apache License 2.0.
Файл: `vendor/mpegts.min.js`.

## Electron

https://www.electronjs.org — MIT License.