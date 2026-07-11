/* Copyright (c) 2013-2016 Jeffrey Pfau
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * PATCH(c-compiler): CMake generates this from version.c.in at configure
 * time; we vendor a static copy (0.10.5, upstream commit 26b7884). */
#include <mgba/core/version.h>

MGBA_EXPORT const char* const gitCommit = "26b7884bc25a5933960f3cdcd98bac1ae14d42e2";
MGBA_EXPORT const char* const gitCommitShort = "26b7884b";
MGBA_EXPORT const char* const gitBranch = "0.10.5";
MGBA_EXPORT const int gitRevision = 0;
MGBA_EXPORT const char* const binaryName = "mgba";
MGBA_EXPORT const char* const projectName = "mGBA";
MGBA_EXPORT const char* const projectVersion = "0.10.5";
