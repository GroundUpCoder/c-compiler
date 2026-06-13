#!/usr/bin/env node
// TLSFAllocator unit tests — pure JS, no OPFS, no browser
'use strict';

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var TLSFAllocator = BLOCK_FS.TLSFAllocator;

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error('  ' + (e.stack || e.message));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEq') + ': ' + a + ' !== ' + b);
}

// ---------------------------------------------------------------
// Basic alloc / free
// ---------------------------------------------------------------

test('malloc returns aligned pointer', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(1);
  assert(a > 0, 'malloc(1) should return non-zero');
  assertEq(a % 8, 0, 'pointer should be 8-byte aligned');

  var b = alloc.malloc(100);
  assert(b > 0 && b !== a, 'two mallocs should return different pointers');
});

test('malloc(0) returns 0', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);
  assertEq(alloc.malloc(0), 0);
});

test('malloc too large returns 0', function () {
  // Use a bounded store that refuses to grow beyond 1MB, so requesting
  // 64MB must fail regardless of block-size representation.
  var maxSize = 1024 * 1024;
  var store = new MemoryByteStore(Math.min(65536, maxSize));
  // Swap resize to enforce the cap.
  var origResize = store.resize;
  store.resize = function (newSize) {
    if (newSize > maxSize) throw new Error('store cap exceeded');
    return origResize.call(store, newSize);
  };
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);
  assertEq(alloc.malloc(64 * 1024 * 1024), 0);
});

test('free and reuse', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  alloc.free(a);
  var b = alloc.malloc(100);
  assertEq(a, b, 'should reuse the freed block');
});

test('free null does nothing', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);
  alloc.free(0); // should not throw
});

// ---------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------

test('merge with next free block on free', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  var b = alloc.malloc(100);
  var c = alloc.malloc(100);

  alloc.free(a);
  alloc.free(b);
  // After freeing a and b (adjacent), they should coalesce
  // Total free bytes should include both

  var fb = alloc.totalFreeBytes();
  var blockCount = alloc.freeBlockCount();

  // We can't test exact values without knowing the pool layout,
  // but we CAN test that we can allocate a block larger than
  // any individual freed block
  var d = alloc.malloc(150);
  assert(d > 0, 'should allocate from coalesced blocks');
  alloc.free(d);
  alloc.free(c);
});

test('merge with prev free block on free', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  var b = alloc.malloc(100);

  alloc.free(b);
  alloc.free(a); // should coalesce a + b

  var large = alloc.malloc(180);
  assert(large > 0, 'should allocate across coalesced boundary');
  alloc.free(large);
});

// ---------------------------------------------------------------
// Realloc
// ---------------------------------------------------------------

test('realloc smaller returns same pointer', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(200);
  var b = alloc.realloc(a, 50);
  assertEq(a, b, 'realloc smaller should return same pointer');
  alloc.free(b);
});

test('realloc null is malloc', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.realloc(0, 100);
  assert(a > 0, 'realloc(null, size) should allocate');
  alloc.free(a);
});

test('realloc zero size is free', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  var b = alloc.realloc(a, 0);
  assertEq(b, 0, 'realloc(ptr, 0) should return 0');
});

test('realloc larger may move', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  var guard = alloc.malloc(100); // prevent in-place growth

  var data = new Uint8Array(100);
  for (var i = 0; i < 100; i++) data[i] = i & 0xFF;
  store.setBytes(a, data);

  var b = alloc.realloc(a, 500);
  assert(b > 0, 'realloc larger should succeed');
  // Data should be preserved
  var readBack = store.getBytes(b, 100);
  for (var j = 0; j < 100; j++) {
    assertEq(readBack[j], j & 0xFF, 'data preserved at offset ' + j);
  }

  alloc.free(b);
  alloc.free(guard);
});

// ---------------------------------------------------------------
// calloc
// ---------------------------------------------------------------

test('calloc zeroes memory', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.calloc(10, 20);
  assert(a > 0);
  var data = store.getBytes(a, 200);
  for (var i = 0; i < 200; i++) {
    assertEq(data[i], 0, 'calloc byte ' + i + ' should be zero');
  }
  alloc.free(a);
});

// ---------------------------------------------------------------
// Stress
// ---------------------------------------------------------------

test('random alloc/free stress', function () {
  var store = new MemoryByteStore(256 * 1024);
  var alloc = new TLSFAllocator(store, 256, 256 * 1024 - 2304);

  var ptrs = [];
  var sizes = [];
  // Use a deterministic seed
  var seed = 42;
  function lcg() {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed;
  }

  for (var iter = 0; iter < 200; iter++) {
    if (ptrs.length === 0 || lcg() % 3 !== 0) {
      // Allocate
      var sz = (lcg() % 1024) + 1;
      var p = alloc.malloc(sz);
      if (p) {
        ptrs.push(p);
        sizes.push(sz);
        // Write a pattern
        var pattern = new Uint8Array(Math.min(sz, 32));
        for (var pi = 0; pi < pattern.length; pi++) pattern[pi] = lcg() & 0xFF;
        store.setBytes(p, pattern);
      }
    } else {
      // Free a random pointer
      var idx = lcg() % ptrs.length;
      alloc.free(ptrs[idx]);
      ptrs.splice(idx, 1);
      sizes.splice(idx, 1);
    }
  }

  // Free remaining
  for (var ri = 0; ri < ptrs.length; ri++) {
    alloc.free(ptrs[ri]);
  }

  // Should have one big free block (everything coalesced)
  assert(alloc.freeBlockCount() <= 2, 'should coalesce to 1-2 blocks after freeing all');
});

test('double free throws', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(100);
  alloc.free(a);
  try {
    alloc.free(a);
    assert(false, 'should have thrown');
  } catch (e) {
    assert(/double free/i.test(e.message), 'should be double-free error');
  }
});

// ---------------------------------------------------------------
// Metadata persistence (read back after construction)
// ---------------------------------------------------------------

test('allocator state survives round trip', function () {
  var store = new MemoryByteStore(65536);
  var alloc = new TLSFAllocator(store, 256, 65536 - 2304);

  var a = alloc.malloc(500);
  var b = alloc.malloc(500);
  alloc.free(a);

  // Recreate allocator from same store
  // Note: this tests that metadata is in the store, not just in JS state
  var alloc2 = new TLSFAllocator(store, 256, 65536 - 2304);

  // b should still be allocated (checked indirectly — free shouldn't throw)
  alloc2.free(b);

  // After freeing b, should be able to alloc everything back
  var c = alloc2.malloc(900);
  assert(c > 0, 'should allocate from coalesced free space');
  alloc2.free(c);
});

// ---------------------------------------------------------------
// Results
// ---------------------------------------------------------------

console.log('--- TLSF Tests ---');
console.log('Passed: ' + passed);
console.log('Failed: ' + failed);

if (failed > 0) process.exit(1);
