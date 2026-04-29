# Game Boy Emulator

Game Boy emulator using [Peanut-GB](https://github.com/deltabeard/Peanut-GB)
(MIT license, commit 8e65698) with a custom APU implementation and SDL frontend.

If no ROM is provided, a built-in test ROM draws a scrolling checkerboard.

## Controls

- Arrow keys = D-pad
- Z = A button
- X = B button
- Enter = Start
- Right Shift = Select

## Usage

Build standalone (uses built-in test ROM):

    node compiler.js vendor/gameboy/bin.json -a compile -o gameboy.html

Build with a ROM:

    node compiler.js vendor/gameboy/targets/pokemon.json -a compile -o pokemon.html

Place ROM files in `roms/` (gitignored).
