/*
 *  c-compiler puNES frontend (GPLv3): global instance definitions.
 *
 *  puNES keeps its cross-TU global instances in core/compilation_unit_orphan.h,
 *  a header #include'd exactly once — by core/main.c, which we replace. So the
 *  core's `info`, `machine`, `vs_system`, `debugger`, `tas` (+ its function
 *  pointers) would otherwise be undefined at link. We define them here, plus
 *  the globals that normally live in the subsystem .c files we don't compile
 *  (nsf/nsf2/tape_data_recorder/unif/dipswitch) and the paused-frame effect
 *  state. cfg/gui/gmouse/ext_win/gui_get_ms are defined in pn_config.c/pn_seam.c.
 */

#include "common.h"
#include "info.h"
#include "clock.h"
#include "vs_system.h"
#include "debugger.h"
#include "tas.h"
#include "nsf.h"
#include "nsfe.h"
#include "tape_data_recorder.h"
#include "unif.h"
#include "dipswitch.h"
#include "video/effects/pause.h"

/* core globals (from compilation_unit_orphan.h) */
_info info;
_machine machine;
_vs_system vs_system;
_debugger debugger;

/* TAS (movie playback) — globals + the format function-pointer table */
_tas tas;
void (*tas_header)(uTCHAR *file);
void (*tas_read)(void);
void (*tas_frame)(void);
void (*tas_rewind)(int32_t frames_to_rewind);
void (*tas_restart_from_begin)(void);

/* globals normally owned by the subsystem .c files we don't compile */
_nsf nsf;
_nsf2 nsf2;
_tape_data_recorder tape_data_recorder;
_unif unif;
_dipswitch dipswitch;
_pause_effect pause_effect;
