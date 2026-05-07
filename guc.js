// UMD wrapper: exports `GUC` to whatever module system is in scope.
//   - Node (CommonJS):    `const GUC = require('./guc.js');`
//   - Browser <script>:   `window.GUC` / `globalThis.GUC` is set.
// For Node ESM, use `createRequire` or a thin wrapper.
;(function(root, factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory();
    } else {
        root.GUC = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
"use strict";

// For internal errors with the compiler itself.
// For user errors, use reportError.
function assert(condition, message) {
    if (!condition) {
        throw new Error(typeof message === 'function' ? message() : message || 'Assertion failed');
    }
}

class Loc {
    constructor(filename, startLine, startColumn, endLine, endColumn) {
        this.filename = filename;
        this.start = { line: startLine, column: startColumn };
        this.end = { line: endLine, column: endColumn };
    }

    join(...locs) {
        const filename = this.filename;
        let start = this.start;
        let end = this.end;
        for (const loc of locs) {
            assert(loc.filename === filename, 'Cannot join locations from different files');
            if (loc.start.line < start.line || (loc.start.line === start.line && loc.start.column < start.column)) {
                start = loc.start;
            }
            if (loc.end.line > end.line || (loc.end.line === end.line && loc.end.column > end.column)) {
                end = loc.end;
            }
        }
        return new Loc(filename, start.line, start.column, end.line, end.column);
    }
}

class UserError {
    constructor(loc, message) {
        this.loc = loc; // Loc
        this.message = message;
    }

    toString() {
        return (
            `${this.message}` +
            `\n  at ${this.loc.filename}:${this.loc.start.line}:${this.loc.start.column}`
        );
    }
}

function withErrorPool(fn) {
    if (_activeErrorPool) {
        throw new Error('Nested error pools are not supported');
    }
    const errors = []; // Array of UserError
    _activeErrorPool = errors;
    try {
        const result = fn();
        return { result, errors };
    } finally {
        _activeErrorPool = null;
    }
}

let _activeErrorPool = null;

// Report a user error at the given location with the given message.
// For internal compiler errors, use assert() or throw directly instead.
function reportError(loc, message) {
    if (!_activeErrorPool) {
        throw new Error('reportError called outside of withErrorPool');
    }
    _activeErrorPool.push(new UserError(loc, message));
}

// TreeBag: an immutable multiset of references built by referencing children.
// `own` may be a Set or null/undefined when the bag is just a container.
// Construction copies `own` defensively, drops empty children, computes `size`
// eagerly (each child's size is already known so this is O(direct children)
// per node and O(N) total over an AST), and freezes the result. Entries are
// never copied into ancestors — iteration / `has` walk the children tree on
// demand, so memory stays O(N) regardless of depth. Suitable for one-shot
// bubble-up metadata in the IR; if you'd query a bag many times, snapshot
// the iteration result yourself.
class TreeBag {
    constructor(own, ...children) {
        this._own = own?.size ? new Set(own) : null;
        this._children = children.filter(c => c.size > 0);
        let n = this._own ? this._own.size : 0;
        for (const c of this._children) n += c.size;
        this.size = n;
        Object.freeze(this._children);
        Object.freeze(this);
    }
    *[Symbol.iterator]() {
        if (this._own) yield* this._own;
        for (const child of this._children) yield* child;
    }
    has(value) {
        if (this._own && this._own.has(value)) return true;
        for (const child of this._children) if (child.has(value)) return true;
        return false;
    }
    forEach(fn) { for (const item of this) fn(item); }
}
const _EMPTY_TREE_BAG = new TreeBag(null);

// TupleMap: a Map whose key is an array of hashables (objects, primitives,
// symbols). Equality is element-by-element identity. Used both for type
// interning (functionTypeOf) and as the backing store for TupleSet.
class TupleMap {
    constructor() {
        this._sentinel = Symbol('sentinel');
        this._map = new Map();
    }
    _keyToMap(key, create) {
        if (!Array.isArray(key)) throw new Error('Key must be an array');
        let map = this._map;
        for (const k of key) {
            if (!map.has(k)) {
                if (!create) return undefined;
                map.set(k, new Map());
            }
            map = map.get(k);
        }
        return map;
    }
    set(key, value) {
        const map = this._keyToMap(key, true);
        map.set(this._sentinel, value);
    }
    get(key) {
        const map = this._keyToMap(key, false);
        return map ? map.get(this._sentinel) : undefined;
    }
    has(key) {
        const map = this._keyToMap(key, false);
        return map ? map.has(this._sentinel) : false;
    }
}

// TupleSet: a set of array-keyed entries, backed by TupleMap. Used as the
// "assumed equal" cycle-break memo in the bisimulation that decides
// structural equivalence of recursive heap types.
class TupleSet {
    constructor() { this._m = new TupleMap(); }
    add(key) { this._m.set(key, true); }
    has(key) { return this._m.has(key); }
}

const T = (() => {

    class Type {
        isIntegralType() {
            return this instanceof IntegralType;
        }
        isFloatingPointType() {
            return this instanceof FloatingPointType;
        }
        isFunctionType() {
            return this instanceof FunctionType;
        }
        isNullable() {
            return this === EXTERNREF || this === FUNCREF || this === EXNREF;
        }
        // `assumed` is an optional TupleSet of pairs (a, b) we're currently
        // assuming equal during a recursive structural check. Top-level
        // callers leave it undefined and we allocate when needed.
        isAssignableTo(other, assumed) {
            if (this === other) return true;
            if (this === REFEXTERN && other === EXTERNREF) return true;
            return false;
        }
    }

    class PrimitiveType extends Type {
        constructor(name) {
            super();
            this.name = name;
        }

        toString() { return this.name; }
    }

    class IntegralType extends PrimitiveType {
        constructor(name, bits, signed, slotType, packedKind) {
            super(name);
            this.bits = bits;
            this.signed = signed;
            // slotType: the IR Type used for the wasm operand-stack/local/global
            // slot. `null` here means "self" — wired up after construction for
            // the slot types themselves (I32, I64).
            this.slotType = slotType;
            // packedKind: the wasm packed encoding name ('i8' | 'i16' | 'i32' |
            // 'i64'), for GC array/struct fields. Unused by codegen so far —
            // metadata for future use.
            this.packedKind = packedKind;
        }
        isAssignableTo(other) {
            if (this === other) return true;
            if (other instanceof IntegralType) {
                return (this.slotType || this) === (other.slotType || other);
            }
            return false;
        }
        // Inclusive bounds for valid values of this type.
        minValue() {
            return this.signed ? -(1n << BigInt(this.bits - 1)) : 0n;
        }
        maxValue() {
            return this.signed ? (1n << BigInt(this.bits - 1)) - 1n
                               : (1n << BigInt(this.bits)) - 1n;
        }
        // True for types narrower than their slot (I8/U8/I16/U16 in i32 slots).
        isPacked() {
            return this.bits < 32;
        }
    }

    class FloatingPointType extends PrimitiveType {
        constructor(name, bits) {
            super(name);
            this.bits = bits;
            this.slotType = this;
            this.packedKind = name;
        }
    }

    class FunctionType extends Type {
        constructor(params, results) {
            super();
            this.params = params; // Array of Types
            this.results = results; // Array of Types
        }

        toString() {
            const paramsStr = this.params.map(t => t.name).join(', ');
            const resultsStr = this.results.map(t => t.name).join(', ');
            return `(${paramsStr}) -> (${resultsStr})`;
        }
    }

    // Abstract heap type: the bottom-of-the-stack heap-type universe — `any`,
    // `eq`, `i31`, `struct`, `array`, `func`, `extern`, plus the empty types
    // `none`/`nofunc`/`noextern`. Each one carries the wasm spec encoding
    // byte that doubles (for nullable refs) as the valtype shorthand.
    class HeapType extends Type {
        constructor(name, byte) {
            super();
            this.name = name;
            this.byte = byte;
        }
        toString() { return this.name; }
        isAssignableTo(other, assumed) {
            if (this === other) return true;
            if (other instanceof HeapType) return _isHeapSubtype(this, other);
            return false;
        }
    }

    // The wasm GC heap-type lattice. Each entry maps a heap type to its
    // direct supertypes (transitive via the BFS in `_isHeapSubtype`).
    const HEAP_HIERARCHY = {
        i31:      ['eq'],
        struct:   ['eq'],
        array:    ['eq'],
        eq:       ['any'],
        none:     ['i31', 'struct', 'array'],
        nofunc:   ['func'],
        noextern: ['extern'],
        any:      [],
        func:     [],
        extern:   [],
    };
    const _heapByName = {};
    function _isHeapSubtype(a, b) {
        if (a === b) return true;
        const queue = [a.name];
        const seen = new Set();
        while (queue.length > 0) {
            const cur = queue.shift();
            if (seen.has(cur)) continue;
            seen.add(cur);
            for (const p of (HEAP_HIERARCHY[cur] || [])) {
                if (_heapByName[p] === b) return true;
                queue.push(p);
            }
        }
        return false;
    }

    // StructType: a wasm GC struct definition. Each `new StructType` is a
    // distinct identity; structural equivalence is decided by
    // `isAssignableTo` via bisimulation. `parent` is an optional explicit
    // supertype (subtype declaration) used by wasm GC subtyping; defaults
    // to null. Fields are { type, mutable, packedKind? } where packedKind
    // is 'i8' or 'i16' for sub-i32 storage in a struct field (separate
    // from operating in i32 slots — wasm GC physically packs them).
    class StructType extends Type {
        constructor(fields, parent = null) {
            super();
            this.fields = fields;
            this.parent = parent;
        }
        toString() {
            const inner = this.fields.map(f =>
                `${f.mutable ? 'mut ' : ''}${f.packedKind || f.type}`).join(', ');
            return `struct{${inner}}`;
        }
        isAssignableTo(other, assumed) {
            if (this === other) return true;
            // struct $X <: struct heap, eq heap, any heap.
            if (other instanceof HeapType) {
                return other === HEAP_STRUCT || other === HEAP_EQ || other === HEAP_ANY;
            }
            if (!(other instanceof StructType)) return false;
            // Subtype declaration: walk parent chain.
            for (let cur = this.parent; cur; cur = cur.parent) {
                if (cur === other) return true;
            }
            // Bisimulation memo so cycles terminate.
            if (!assumed) assumed = new TupleSet();
            const key = [this, other];
            if (assumed.has(key)) return true;
            assumed.add(key);
            if (this.fields.length !== other.fields.length) return false;
            for (let i = 0; i < this.fields.length; i++) {
                const a = this.fields[i], b = other.fields[i];
                if (a.mutable !== b.mutable) return false;
                if ((a.packedKind || null) !== (b.packedKind || null)) return false;
                if (!a.type.isAssignableTo(b.type, assumed)) return false;
                // Mutable fields are invariant (need both directions).
                if (a.mutable && !b.type.isAssignableTo(a.type, assumed)) return false;
            }
            return true;
        }
    }

    // ArrayType: a wasm GC array. `mutable` controls whether elements can
    // be set after construction; `packedKind` is 'i8'/'i16' for byte/short
    // arrays (whose elements are stored packed but observed as i32 via
    // `_s`/`_u` getters in codegen).
    class ArrayType extends Type {
        constructor(elementType, mutable, packedKind = null) {
            super();
            this.elementType = elementType;
            this.mutable = mutable;
            this.packedKind = packedKind;
        }
        toString() {
            return `array(${this.mutable ? 'mut ' : ''}${this.packedKind || this.elementType})`;
        }
        isAssignableTo(other, assumed) {
            if (this === other) return true;
            if (other instanceof HeapType) {
                return other === HEAP_ARRAY || other === HEAP_EQ || other === HEAP_ANY;
            }
            if (!(other instanceof ArrayType)) return false;
            if (this.mutable !== other.mutable) return false;
            if ((this.packedKind || null) !== (other.packedKind || null)) return false;
            if (!assumed) assumed = new TupleSet();
            const key = [this, other];
            if (assumed.has(key)) return true;
            assumed.add(key);
            if (!this.elementType.isAssignableTo(other.elementType, assumed)) return false;
            if (this.mutable &&
                !other.elementType.isAssignableTo(this.elementType, assumed)) return false;
            return true;
        }
    }

    // RefType: `(ref null? <heap>)`. heapType is a HeapType, StructType,
    // ArrayType, or FunctionType (for func refs). Two RefTypes are
    // assignable iff the source's nullability is no stricter than the
    // target's (non-null assignable to nullable, not the other way) AND
    // the heap types are assignable.
    class RefType extends Type {
        constructor(heapType, nullable) {
            super();
            this.heapType = heapType;
            this.nullable = nullable;
        }
        toString() {
            return `ref${this.nullable ? ' null' : ''} ${this.heapType}`;
        }
        isAssignableTo(other, assumed) {
            if (this === other) return true;
            if (!(other instanceof RefType)) return false;
            // (ref T) <: (ref null T), but not the reverse.
            if (this.nullable && !other.nullable) return false;
            return this.heapType.isAssignableTo(other.heapType, assumed);
        }
    }

    // Singletons for abstract heap types. The byte values are the wasm
    // spec's heap-type encoding bytes (which double as valtype shorthands
    // for nullable refs to that heap type).
    const HEAP_NOFUNC   = new HeapType('nofunc',   0x73);
    const HEAP_NOEXTERN = new HeapType('noextern', 0x72);
    const HEAP_NONE     = new HeapType('none',     0x71);
    const HEAP_FUNC     = new HeapType('func',     0x70);
    const HEAP_EXTERN   = new HeapType('extern',   0x6F);
    const HEAP_ANY      = new HeapType('any',      0x6E);
    const HEAP_EQ       = new HeapType('eq',       0x6D);
    const HEAP_I31      = new HeapType('i31',      0x6C);
    const HEAP_STRUCT   = new HeapType('struct',   0x6B);
    const HEAP_ARRAY    = new HeapType('array',    0x6A);
    _heapByName.nofunc = HEAP_NOFUNC;
    _heapByName.noextern = HEAP_NOEXTERN;
    _heapByName.none = HEAP_NONE;
    _heapByName.func = HEAP_FUNC;
    _heapByName.extern = HEAP_EXTERN;
    _heapByName.any = HEAP_ANY;
    _heapByName.eq = HEAP_EQ;
    _heapByName.i31 = HEAP_I31;
    _heapByName.struct = HEAP_STRUCT;
    _heapByName.array = HEAP_ARRAY;

    // I32/I64 are their own slot type — wire the self-reference after construction.
    const I32 = new IntegralType('i32', 32, true, null, 'i32');
    I32.slotType = I32;
    const I64 = new IntegralType('i64', 64, true, null, 'i64');
    I64.slotType = I64;
    // Same wasm slot as the signed counterpart; differs only in literal range
    // and signedness-sensitive op selection (div_u, lt_u, …).
    const U32 = new IntegralType('u32', 32, false, I32, 'i32');
    const U64 = new IntegralType('u64', 64, false, I64, 'i64');
    // Packed types: stored in i32 slots, kept in canonical form (sign-extended
    // for signed, zero-extended for unsigned) by post-op fixups in codegen.
    const I8 = new IntegralType('i8', 8, true, I32, 'i8');
    const U8 = new IntegralType('u8', 8, false, I32, 'i8');
    const I16 = new IntegralType('i16', 16, true, I32, 'i16');
    const U16 = new IntegralType('u16', 16, false, I32, 'i16');
    const F32 = new FloatingPointType('f32', 32);
    const F64 = new FloatingPointType('f64', 64);
    const REFEXTERN = new PrimitiveType('refextern'); // non-nullable
    const EXTERNREF = new PrimitiveType('externref'); // nullable
    const FUNCREF = new PrimitiveType('funcref');
    // EXNREF: the wasm exception-handling proposal's exnref valtype (0x69).
    // Always nullable. Produced by `catch_ref` / `catch_all_ref` and consumed
    // by `throw_ref`. Used by lowerTryFinally to implement run-fin-then-rethrow.
    const EXNREF = new PrimitiveType('exnref');

    const functionTypeCache = new TupleMap();
    const functionTypeOf = (params, results) => {
        // Get or create a FunctionType for the given params and results
        const key = [...params, '/', ...results];
        let ft = functionTypeCache.get(key);
        if (!ft) {
            ft = new FunctionType(params, results);
            functionTypeCache.set(key, ft);
        }
        return ft;
    };

    // RefType factory: interned by (heapType, nullable). StructType/ArrayType
    // themselves keep distinct identity per `new`, but the wrapper RefType is
    // interned so that "ref to the same heap with the same nullability" is
    // always the same JS instance — this matters for local-decl grouping in
    // codegen and for `===` reference equality.
    const refTypeCache = new TupleMap();
    const refTypeOf = (heapType, nullable) => {
        const key = [heapType, !!nullable];
        let r = refTypeCache.get(key);
        if (!r) {
            r = new RefType(heapType, !!nullable);
            refTypeCache.set(key, r);
        }
        return r;
    };

    return {
        Type,
        PrimitiveType,
        IntegralType,
        FloatingPointType,
        FunctionType,
        HeapType,
        StructType,
        ArrayType,
        RefType,
        I32, I64, U32, U64, I8, U8, I16, U16,
        F32, F64,
        REFEXTERN,
        EXTERNREF,
        FUNCREF,
        EXNREF,
        HEAP_ANY, HEAP_EQ, HEAP_I31, HEAP_STRUCT, HEAP_ARRAY,
        HEAP_FUNC, HEAP_EXTERN, HEAP_NONE, HEAP_NOFUNC, HEAP_NOEXTERN,
        functionTypeOf,
        refTypeOf,
    };
})();

// OPS: shared op registry used by both IR (validation) and CODEGEN (emission).
// Each entry combines what was previously two parallel tables:
//   - `result`:   'same' (= operand type) | 'i32' (comparison)
//   - `signed`:   true if codegen picks `_s`/`_u` suffix based on the operand's
//                 IR-type signedness (only meaningful for integer ops; floats
//                 use the unsuffixed opcode regardless)
//   - `opcodes`:  { `${slotName}.${variant}`: opcodeByte, ... }
//                 The set of `slotName`s in this map IS the set of types the
//                 op is defined for — no separate `for: 'int'/'float'` flag.
// Op names match wasm's signedness-agnostic spelling: `div`, `lt`, `shr`.
const OPS = (() => {
    const BINOPS = {
        add:      { result: 'same', signed: false, opcodes: {
            'i32.add': 0x6A, 'i64.add': 0x7C, 'f32.add': 0x92, 'f64.add': 0xA0,
        }},
        sub:      { result: 'same', signed: false, opcodes: {
            'i32.sub': 0x6B, 'i64.sub': 0x7D, 'f32.sub': 0x93, 'f64.sub': 0xA1,
        }},
        mul:      { result: 'same', signed: false, opcodes: {
            'i32.mul': 0x6C, 'i64.mul': 0x7E, 'f32.mul': 0x94, 'f64.mul': 0xA2,
        }},
        div:      { result: 'same', signed: true,  opcodes: {
            'i32.div_s': 0x6D, 'i32.div_u': 0x6E,
            'i64.div_s': 0x7F, 'i64.div_u': 0x80,
            'f32.div': 0x95, 'f64.div': 0xA3,
        }},
        rem:      { result: 'same', signed: true,  opcodes: {
            'i32.rem_s': 0x6F, 'i32.rem_u': 0x70,
            'i64.rem_s': 0x81, 'i64.rem_u': 0x82,
        }},
        and:      { result: 'same', signed: false, opcodes: { 'i32.and': 0x71, 'i64.and': 0x83 }},
        or:       { result: 'same', signed: false, opcodes: { 'i32.or':  0x72, 'i64.or':  0x84 }},
        xor:      { result: 'same', signed: false, opcodes: { 'i32.xor': 0x73, 'i64.xor': 0x85 }},
        shl:      { result: 'same', signed: false, opcodes: { 'i32.shl': 0x74, 'i64.shl': 0x86 }},
        shr:      { result: 'same', signed: true,  opcodes: {
            'i32.shr_s': 0x75, 'i32.shr_u': 0x76,
            'i64.shr_s': 0x87, 'i64.shr_u': 0x88,
        }},
        rotl:     { result: 'same', signed: false, opcodes: { 'i32.rotl': 0x77, 'i64.rotl': 0x89 }},
        rotr:     { result: 'same', signed: false, opcodes: { 'i32.rotr': 0x78, 'i64.rotr': 0x8A }},
        eq:       { result: 'i32',  signed: false, opcodes: {
            'i32.eq': 0x46, 'i64.eq': 0x51, 'f32.eq': 0x5B, 'f64.eq': 0x61,
        }},
        ne:       { result: 'i32',  signed: false, opcodes: {
            'i32.ne': 0x47, 'i64.ne': 0x52, 'f32.ne': 0x5C, 'f64.ne': 0x62,
        }},
        lt:       { result: 'i32',  signed: true,  opcodes: {
            'i32.lt_s': 0x48, 'i32.lt_u': 0x49,
            'i64.lt_s': 0x53, 'i64.lt_u': 0x54,
            'f32.lt': 0x5D, 'f64.lt': 0x63,
        }},
        gt:       { result: 'i32',  signed: true,  opcodes: {
            'i32.gt_s': 0x4A, 'i32.gt_u': 0x4B,
            'i64.gt_s': 0x55, 'i64.gt_u': 0x56,
            'f32.gt': 0x5E, 'f64.gt': 0x64,
        }},
        le:       { result: 'i32',  signed: true,  opcodes: {
            'i32.le_s': 0x4C, 'i32.le_u': 0x4D,
            'i64.le_s': 0x57, 'i64.le_u': 0x58,
            'f32.le': 0x5F, 'f64.le': 0x65,
        }},
        ge:       { result: 'i32',  signed: true,  opcodes: {
            'i32.ge_s': 0x4E, 'i32.ge_u': 0x4F,
            'i64.ge_s': 0x59, 'i64.ge_u': 0x5A,
            'f32.ge': 0x60, 'f64.ge': 0x66,
        }},
        min:      { result: 'same', signed: false, opcodes: { 'f32.min': 0x96, 'f64.min': 0xA4 }},
        max:      { result: 'same', signed: false, opcodes: { 'f32.max': 0x97, 'f64.max': 0xA5 }},
        copysign: { result: 'same', signed: false, opcodes: { 'f32.copysign': 0x98, 'f64.copysign': 0xA6 }},
    };
    const UNARYOPS = {
        clz:     { result: 'same', opcodes: { 'i32.clz': 0x67, 'i64.clz': 0x79 }},
        ctz:     { result: 'same', opcodes: { 'i32.ctz': 0x68, 'i64.ctz': 0x7A }},
        popcnt:  { result: 'same', opcodes: { 'i32.popcnt': 0x69, 'i64.popcnt': 0x7B }},
        eqz:     { result: 'i32',  opcodes: { 'i32.eqz': 0x45, 'i64.eqz': 0x50 }},
        abs:     { result: 'same', opcodes: { 'f32.abs': 0x8B, 'f64.abs': 0x99 }},
        neg:     { result: 'same', opcodes: { 'f32.neg': 0x8C, 'f64.neg': 0x9A }},
        ceil:    { result: 'same', opcodes: { 'f32.ceil': 0x8D, 'f64.ceil': 0x9B }},
        floor:   { result: 'same', opcodes: { 'f32.floor': 0x8E, 'f64.floor': 0x9C }},
        trunc:   { result: 'same', opcodes: { 'f32.trunc': 0x8F, 'f64.trunc': 0x9D }},
        nearest: { result: 'same', opcodes: { 'f32.nearest': 0x90, 'f64.nearest': 0x9E }},
        sqrt:    { result: 'same', opcodes: { 'f32.sqrt': 0x91, 'f64.sqrt': 0x9F }},
    };
    // CONVERSIONS: keyed by the wasm op name (e.g. 'i64.extend_i32_s'). Each
    // op maps to a specific operand slot type and a specific result type. The
    // signed/unsigned variant is part of the op name — the user picks; we
    // don't auto-pick from operand IR-type signedness because these ops are
    // too heterogeneous (e.g. trunc's suffix describes the *result*'s
    // interpretation, while extend's describes the *source*'s). Result types
    // use unsigned IR variants (U32/U64) when the wasm op produces an
    // unsigned interpretation, so the IR type aligns with the user's intent.
    const CONVERSIONS = {
        'i32.wrap_i64':        { result: T.I32, operandSlot: 'i64', opcode: 0xA7 },
        'i64.extend_i32_s':    { result: T.I64, operandSlot: 'i32', opcode: 0xAC },
        'i64.extend_i32_u':    { result: T.U64, operandSlot: 'i32', opcode: 0xAD },
        'i32.trunc_f32_s':     { result: T.I32, operandSlot: 'f32', opcode: 0xA8 },
        'i32.trunc_f32_u':     { result: T.U32, operandSlot: 'f32', opcode: 0xA9 },
        'i32.trunc_f64_s':     { result: T.I32, operandSlot: 'f64', opcode: 0xAA },
        'i32.trunc_f64_u':     { result: T.U32, operandSlot: 'f64', opcode: 0xAB },
        'i64.trunc_f32_s':     { result: T.I64, operandSlot: 'f32', opcode: 0xAE },
        'i64.trunc_f32_u':     { result: T.U64, operandSlot: 'f32', opcode: 0xAF },
        'i64.trunc_f64_s':     { result: T.I64, operandSlot: 'f64', opcode: 0xB0 },
        'i64.trunc_f64_u':     { result: T.U64, operandSlot: 'f64', opcode: 0xB1 },
        'f32.convert_i32_s':   { result: T.F32, operandSlot: 'i32', opcode: 0xB2 },
        'f32.convert_i32_u':   { result: T.F32, operandSlot: 'i32', opcode: 0xB3 },
        'f32.convert_i64_s':   { result: T.F32, operandSlot: 'i64', opcode: 0xB4 },
        'f32.convert_i64_u':   { result: T.F32, operandSlot: 'i64', opcode: 0xB5 },
        'f32.demote_f64':      { result: T.F32, operandSlot: 'f64', opcode: 0xB6 },
        'f64.convert_i32_s':   { result: T.F64, operandSlot: 'i32', opcode: 0xB7 },
        'f64.convert_i32_u':   { result: T.F64, operandSlot: 'i32', opcode: 0xB8 },
        'f64.convert_i64_s':   { result: T.F64, operandSlot: 'i64', opcode: 0xB9 },
        'f64.convert_i64_u':   { result: T.F64, operandSlot: 'i64', opcode: 0xBA },
        'f64.promote_f32':     { result: T.F64, operandSlot: 'f32', opcode: 0xBB },
        'i32.reinterpret_f32': { result: T.I32, operandSlot: 'f32', opcode: 0xBC },
        'i64.reinterpret_f64': { result: T.I64, operandSlot: 'f64', opcode: 0xBD },
        'f32.reinterpret_i32': { result: T.F32, operandSlot: 'i32', opcode: 0xBE },
        'f64.reinterpret_i64': { result: T.F64, operandSlot: 'i64', opcode: 0xBF },
        // Sign-extension ops (single-byte opcodes vs the shl/shr_s pattern).
        // Useful for narrowing back to i8/i16 representation in i32 slots
        // and for the i64 sub-int sign extensions.
        'i32.extend8_s':       { result: T.I32, operandSlot: 'i32', opcode: 0xC0 },
        'i32.extend16_s':      { result: T.I32, operandSlot: 'i32', opcode: 0xC1 },
        'i64.extend8_s':       { result: T.I64, operandSlot: 'i64', opcode: 0xC2 },
        'i64.extend16_s':      { result: T.I64, operandSlot: 'i64', opcode: 0xC3 },
        'i64.extend32_s':      { result: T.I64, operandSlot: 'i64', opcode: 0xC4 },
    };
    // Linear-memory loads. `result` is the IR-level type the loaded value
    // takes — sub-i32 loads with sign/zero extension produce packed types
    // already in canonical form (no codegen fixup needed). `naturalAlign` is
    // log2(bytes); the wasm validator allows any align ≤ natural.
    const LOADS = {
        'i32.load':     { result: T.I32, opcode: 0x28, naturalAlign: 2 },
        'i64.load':     { result: T.I64, opcode: 0x29, naturalAlign: 3 },
        'f32.load':     { result: T.F32, opcode: 0x2A, naturalAlign: 2 },
        'f64.load':     { result: T.F64, opcode: 0x2B, naturalAlign: 3 },
        'i32.load8_s':  { result: T.I8,  opcode: 0x2C, naturalAlign: 0 },
        'i32.load8_u':  { result: T.U8,  opcode: 0x2D, naturalAlign: 0 },
        'i32.load16_s': { result: T.I16, opcode: 0x2E, naturalAlign: 1 },
        'i32.load16_u': { result: T.U16, opcode: 0x2F, naturalAlign: 1 },
        'i64.load8_s':  { result: T.I64, opcode: 0x30, naturalAlign: 0 },
        'i64.load8_u':  { result: T.U64, opcode: 0x31, naturalAlign: 0 },
        'i64.load16_s': { result: T.I64, opcode: 0x32, naturalAlign: 1 },
        'i64.load16_u': { result: T.U64, opcode: 0x33, naturalAlign: 1 },
        'i64.load32_s': { result: T.I64, opcode: 0x34, naturalAlign: 2 },
        'i64.load32_u': { result: T.U64, opcode: 0x35, naturalAlign: 2 },
    };

    // Linear-memory stores. `valueSlot` is the wasm slot the value operand
    // must occupy — any IR type whose slot matches is accepted. Sub-i32
    // stores truncate (e.g. `i32.store8` writes the low byte).
    const STORES = {
        'i32.store':   { valueSlot: 'i32', opcode: 0x36, naturalAlign: 2 },
        'i64.store':   { valueSlot: 'i64', opcode: 0x37, naturalAlign: 3 },
        'f32.store':   { valueSlot: 'f32', opcode: 0x38, naturalAlign: 2 },
        'f64.store':   { valueSlot: 'f64', opcode: 0x39, naturalAlign: 3 },
        'i32.store8':  { valueSlot: 'i32', opcode: 0x3A, naturalAlign: 0 },
        'i32.store16': { valueSlot: 'i32', opcode: 0x3B, naturalAlign: 1 },
        'i64.store8':  { valueSlot: 'i64', opcode: 0x3C, naturalAlign: 0 },
        'i64.store16': { valueSlot: 'i64', opcode: 0x3D, naturalAlign: 1 },
        'i64.store32': { valueSlot: 'i64', opcode: 0x3E, naturalAlign: 2 },
    };

    return Object.freeze({ BINOPS, UNARYOPS, CONVERSIONS, LOADS, STORES });
})();

const IR = (() => {

    class Program {
        // memorySpec (optional): {
        //   staticDataBase?,  // start address for auto-laid-out static
        //                     //   data (default 0). All BytesLiterals and
        //                     //   MutableBytesLiterals are placed starting
        //                     //   here.
        //   stackPages?,      // bytes of stack to reserve, in 64KB pages.
        //                     //   When > 0, codegen auto-creates a mutable
        //                     //   `__stack_pointer` global initialized to
        //                     //   the top of the stack, and computes
        //                     //   `IR.HeapBase` to point at the first byte
        //                     //   above the stack. Functions with
        //                     //   StackSlots / Alloca / containsAlloca get
        //                     //   an auto-generated SP-saving prologue.
        //   minHeapPages?,    // pages reserved for heap above the stack.
        //                     //   Computed-minPages = ceil(heapBase /
        //                     //   65536) + minHeapPages.
        //   minPages?,        // explicit min pages. Required when
        //                     //   stackPages is absent. Ignored (computed)
        //                     //   when stackPages is set.
        //   maxPages?,        // optional upper bound
        //   exportName?,      // if set, export the memory under this name
        // }
        // tables   — Array<IR.Table>, optional.
        // elements — Array<IR.ElementSegment>, optional. (Active segments only;
        //   declarative segments for RefFunc'd functions are auto-emitted by
        //   the codegen.)
        // tags     — Array<IR.Tag>, optional. Exception tags for throw/catch.
        // customSections — Array<{name: string, bytes: Uint8Array|number[]}>,
        //   optional. Each entry becomes a wasm custom section (id 0) appended
        //   after the data section, in array order. The frontend is responsible
        //   for the payload bytes; codegen just frames them with the standard
        //   custom-section header (length-prefixed UTF-8 name + raw payload).
        // dataInit — Uint8Array | number[], optional. User-supplied initial
        //   linear-memory contents starting at memorySpec.staticDataBase.
        //   Placed before any BytesLiterals/MutableBytesLiterals. Frontends
        //   can also (preferably) use IR.MutableBytesLiteral to declare
        //   addressable, mutable static blobs without committing to fixed
        //   absolute addresses up front.
        constructor(functions, variables, memorySpec, tables, elements, tags, customSections, dataInit) {
            this.functions = functions;
            this.variables = variables;
            this.memorySpec = memorySpec || null;
            this.tables = tables || [];
            this.elements = elements || [];
            this.tags = tags || [];
            this.customSections = customSections || [];
            this.dataInit = dataInit ? new Uint8Array(dataInit) : null;
            Object.freeze(this.functions);
            Object.freeze(this.variables);
            Object.freeze(this.tables);
            Object.freeze(this.elements);
            Object.freeze(this.tags);
            Object.freeze(this.customSections);
            if (this.memorySpec) Object.freeze(this.memorySpec);
            Object.freeze(this);
        }
    }

    // Table: a single wasm table. Like memory or a global, a table can be
    // imported, exported, or both. Defined tables get auto-zero-initialized
    // (or null-ref-initialized for ref types) at instantiation.
    class Table {
        constructor(loc, importSpec, exportSpec, refType, minSize, maxSize) {
            this.loc = loc;
            this.importSpec = importSpec;
            this.exportSpec = exportSpec;
            this.refType = refType;       // T.FUNCREF / T.EXTERNREF / a RefType
            this.minSize = minSize;
            this.maxSize = maxSize === undefined ? null : maxSize;
            Object.freeze(this);
        }
    }

    // Tag: a wasm exception tag. Like a function/global/table, it can be
    // imported, exported, or both. The `type` is a FunctionType whose
    // *params* describe the payload carried by `throw`/caught at the
    // handler. Results must be empty.
    class Tag {
        constructor(loc, importSpec, exportSpec, type) {
            this.loc = loc;
            this.importSpec = importSpec;
            this.exportSpec = exportSpec;
            this.type = type;
            assert(type instanceof T.FunctionType,
                'Tag: type must be a FunctionType');
            assert(type.results.length === 0,
                'Tag: type results must be empty (only params describe payload)');
            Object.freeze(this);
        }
    }

    // ElementSegment: an *active* element segment that populates a region
    // of a table at module instantiation. Functions are placed at the table
    // starting at `offset`. The segment uses the wasm form 0 encoding
    // (`0x00 <offset_expr> <vec(funcidx)>`) which assumes table 0 + funcref
    // — that's what we emit when the table is index 0; for other tables
    // the codegen falls back to form 0x02.
    class ElementSegment {
        constructor(loc, table, offset, functions) {
            this.loc = loc;
            this.table = table;        // IR.Table
            this.offset = offset;      // i32 number (constant offset)
            this.functions = functions; // Array<IR.Function>
            Object.freeze(this.functions);
            Object.freeze(this);
        }
    }

    class ImportSpec {
        constructor(module, name) {
            this.module = module;
            this.name = name;
            Object.freeze(this);
        }
    }

    class ExportSpec {
        constructor(name) {
            this.name = name;
            Object.freeze(this);
        }
    }

    class Variable {
        constructor(loc, mutable, name, type) {
            this.loc = loc; // Loc
            this.mutable = mutable;
            this.name = name;
            this.type = type; // Type
        }
    }

    class GlobalVariable extends Variable {
        constructor(loc, importSpec, exportSpec, mutable, name, type, init) {
            super(loc, mutable, name, type);
            this.importSpec = importSpec; // ImportSpec or null
            this.exportSpec = exportSpec; // ExportSpec or null
            this.init = init; // Expression or null (for imports)
            Object.freeze(this);
        }
    }

    class LocalVariable extends Variable {
        constructor(loc, mutable, name, type) {
            super(loc, mutable, name, type);
            Object.freeze(this);
        }
    }

    class Function {
        constructor(loc, importSpec, exportSpec, name, type, params, locals, body) {
            this.loc = loc; // Loc
            this.importSpec = importSpec; // ImportSpec or null
            this.exportSpec = exportSpec; // ExportSpec or null
            this.name = name;
            this.type = type; // FunctionType
            this.params = params || []; // Array of LocalVariable, length = type.params.length
            this.locals = locals || []; // Array of LocalVariable (extra locals beyond params)
            this.body = body; // Expression or null (for imports)

            if (!importSpec) {
                assert(this.params.length === type.params.length, () =>
                    `Function ${name}: ${this.params.length} param vars vs ${type.params.length} param types`);
                for (let i = 0; i < this.params.length; i++) {
                    assert(this.params[i].type === type.params[i], () =>
                        `Function ${name}: param ${i} type mismatch (var=${this.params[i].type}, type=${type.params[i]})`);
                }
            }
            Object.freeze(this.params);
            Object.freeze(this.locals);
            Object.freeze(this);
        }
    }

    // Abstract base class for all expressions.
    //
    // Children are sub-expressions whose stack effects feed into this one.
    // Bubble-up metadata is computed eagerly in `_finalize()`, which every
    // leaf constructor MUST call as its last act. Subclasses contribute by
    // overriding the corresponding `_compute…` method (always calling
    // `super._compute…`):
    //
    //   - breakMap:    Map<label, TreeBag<Break>>
    //   - continueMap: Map<label, TreeBag<Continue>>
    //       Every Break/Continue node referencing this label inside the
    //       subtree. Holding the actual nodes (not just kinds) lets Block
    //       type-check break args against its own resultTypes and surface
    //       the offending Break's own loc. Block strips its own label so
    //       outer scopes don't see it.
    //   - compoundTypes: TreeBag<FunctionType>
    //       FunctionTypes the wasm type section must contain to encode this
    //       subtree (e.g. a Block with multi-value results needs its block
    //       type registered). Codegen iterates compoundTypes on each function
    //       body — no ad-hoc tree walk required.
    //   - stringLiterals: TreeBag<StringLiteral>
    //       Every StringLiteral inside this subtree. Codegen enumerates the
    //       unique string values across function bodies and registers each
    //       as an imported externref global from module `'#'` (the
    //       importedStringConstants compile option resolves them to JS
    //       strings at instantiation).
    //   - bytesLiterals: TreeBag<BytesLiteral>
    //       Every BytesLiteral inside this subtree. Codegen lays them out
    //       in linear memory (deduplicated by content), emits one active
    //       data segment per unique blob, and resolves each BytesLiteral
    //       to its address.
    //   - referencedTypes: TreeBag<StructType|ArrayType|FunctionType>
    //       Concrete heap types directly mentioned by GC ops in this
    //       subtree (e.g. a StructNew names its StructType, RefNull names
    //       a heap type, etc.). Codegen uses this to seed the type
    //       section's transitive closure.
    //   - referencedFunctions: TreeBag<Function>
    //       Functions referenced via RefFunc. wasm requires every such
    //       function be "declared" (via export, active element segment,
    //       or declarative segment) before ref.func can take its address.
    //       Codegen auto-emits a declarative element segment for these.
    //
    // Two scalar bubble-up fields are computed eagerly in this base
    // constructor (no `_compute…` hook required because there's nothing
    // for subclasses to override):
    //
    //   - nodeCount: 1 + Σ children.nodeCount. Used by the optimizer for
    //     size-bounded inlining decisions. O(1) at the call site.
    //   - linearity: 'UNRESTRICTED' (safe to duplicate or drop in a
    //     substitution position) or 'LINEAR' (must be evaluated exactly
    //     once, in the original eval-order position). A node is
    //     UNRESTRICTED iff its op is intrinsically pure (no side effects,
    //     no traps, no allocation identity, deterministic) AND every
    //     child is UNRESTRICTED. Subclasses pass their op-intrinsic
    //     linearity as the optional 4th constructor arg; default LINEAR.
    //
    // After `_finalize()` the instance is frozen; IR nodes are immutable.
    class Expression {
        constructor(loc, types, children, opLinearity = 'LINEAR') {
            this.loc = loc;
            this.types = types;       // Array<Type> — values left on the wasm stack
            this.children = children; // Array<Expression>
            let nc = 1, lin = opLinearity;
            for (const c of children) {
                nc += c.nodeCount;
                if (c.linearity !== 'UNRESTRICTED') lin = 'LINEAR';
            }
            this.nodeCount = nc;
            this.linearity = lin;
        }

        // Idempotent: safe to call from intermediate constructors as well as
        // leaves. Sets the bubble-up metadata then freezes the instance and
        // its contained arrays. (Object.freeze is shallow; we recurse one
        // level into the arrays we own.)
        _finalize() {
            if (Object.isFrozen(this)) return;
            this.breakMap = this._computeBreakMap();
            this.continueMap = this._computeContinueMap();
            this.compoundTypes = this._computeCompoundTypes();
            this.stringLiterals = this._computeStringLiterals();
            this.bytesLiterals = this._computeBytesLiterals();
            this.referencedTypes = this._computeReferencedTypes();
            this.referencedFunctions = this._computeReferencedFunctions();
            this.tableReferencedFunctions = this._computeTableReferencedFunctions();
            this.unclaimedSlots = this._computeUnclaimedSlots();
            this.frameNodes = this._computeFrameNodes();
            this.containsAlloca = this._computeContainsAlloca();
            this.hasNullTableCallIndirect =
                this._computeHasNullTableCallIndirect();
            Object.freeze(this.types);
            Object.freeze(this.children);
            Object.freeze(this);
        }

        _computeBreakMap() {
            return Expression._joinLabelMaps(this.children, c => c.breakMap);
        }

        _computeContinueMap() {
            return Expression._joinLabelMaps(this.children, c => c.continueMap);
        }

        _computeCompoundTypes() {
            return new TreeBag(null, ...this.children.map(c => c.compoundTypes));
        }

        _computeStringLiterals() {
            return new TreeBag(null, ...this.children.map(c => c.stringLiterals));
        }

        _computeBytesLiterals() {
            return new TreeBag(null, ...this.children.map(c => c.bytesLiterals));
        }

        _computeReferencedTypes() {
            return new TreeBag(null, ...this.children.map(c => c.referencedTypes));
        }

        _computeReferencedFunctions() {
            return new TreeBag(null, ...this.children.map(c => c.referencedFunctions));
        }

        // tableReferencedFunctions: functions whose i32 table-index was taken
        // via `IR.FuncIndex(f)`. Codegen synthesizes a single auto-table
        // (funcref) populated with these so `IR.CallIndirect` works against
        // the same indices the FuncIndex literals refer to. Tree-shake uses
        // this bag the same way as `referencedFunctions` — anything in it is
        // alive.
        _computeTableReferencedFunctions() {
            return new TreeBag(null,
                ...this.children.map(c => c.tableReferencedFunctions));
        }

        // Re-construct this node with replacement children in the same order
        // as `this.children`. Used by `walkIR` to rebuild a subtree when any
        // descendant changes; identity-preserving callers skip this when no
        // child actually changed. Re-runs the constructor (and thus
        // `_finalize`), so validation / bubble-up bags are recomputed.
        // Leaf nodes (children.length === 0) never have this called on them
        // and don't need to override; every non-leaf subclass must.
        _withChildren(newChildren) {
            throw new Error(
                `${this.constructor.name} must implement _withChildren ` +
                `(node has ${this.children.length} children)`);
        }

        // unclaimedSlots: TreeBag<StackSlot> — StackSlots referenced via
        // StackSlotAddr in this subtree that have not yet been "claimed" by
        // an enclosing Block scope. A Block consumes its body's
        // unclaimedSlots into a fresh FrameNode and re-publishes empty.
        // Anything still unclaimed at a Function body is laid out by the
        // function's outer frame.
        _computeUnclaimedSlots() {
            return new TreeBag(null, ...this.children.map(c => c.unclaimedSlots));
        }

        // frameNodes: TreeBag<FrameNode> — already-rooted scope frames from
        // descendant Blocks. Each Block packages its body's unclaimedSlots
        // and frameNodes into a single FrameNode and bubbles a singleton
        // bag up. Order is preserved (TreeBag honors iteration order), so
        // sibling FrameNodes from disjoint scopes stay disjoint and codegen
        // can apply stack coloring (sibling overlay).
        _computeFrameNodes() {
            return new TreeBag(null, ...this.children.map(c => c.frameNodes));
        }

        // containsAlloca: bool — disables stack coloring on the path from
        // the Alloca up to the function frame, since alloca dynamically
        // bumps SP and we'd lose track of overlay regions.
        _computeContainsAlloca() {
            for (const c of this.children) if (c.containsAlloca) return true;
            return false;
        }

        // hasNullTableCallIndirect: bool — at least one CallIndirect with
        // table === null appears in this subtree. Codegen needs to know so
        // it can synthesize the auto-table (with at least a null entry)
        // even when no IR.FuncIndex references exist.
        _computeHasNullTableCallIndirect() {
            for (const c of this.children) {
                if (c.hasNullTableCallIndirect) return true;
            }
            return false;
        }

        // Union of `Map<label, TreeBag<X>>` across children, indexed by label.
        static _joinLabelMaps(children, getMap) {
            const out = new Map();
            for (const child of children) {
                for (const [label, set] of getMap(child)) {
                    const existing = out.get(label);
                    out.set(label, existing
                        ? new TreeBag(null, existing, set)
                        : set);
                }
            }
            return out;
        }
    }

    class Literal extends Expression {
        constructor(loc, type, value) {
            if (typeof value === 'bigint') {
                assert(type.isIntegralType(), 'Type must be integral for integer literals');
                const min = type.minValue();
                const max = type.maxValue();
                assert(value >= min && value <= max, () =>
                    `Literal value ${value}n out of range for ${type} (${min}..${max})`);
            } else if (typeof value === 'number') {
                assert(type.isFloatingPointType(), 'Type must be floating point for float literals');
            } else if (typeof value === 'string') {
                assert(type === T.REFEXTERN, 'Type must be refextern for string literals');
            } else {
                assert(false, 'Invalid literal value type');
            }
            super(loc, [type], [], 'UNRESTRICTED');
            this.type = type;
            this.value = value;
            // Only finalize if we are the actual class being constructed —
            // a subclass (StringLiteral) will call _finalize() itself after
            // adding its own fields.
            if (new.target === Literal) this._finalize();
        }
    }

    class StringLiteral extends Literal {
        constructor(loc, value) {
            super(loc, T.REFEXTERN, value);
            this._finalize();
        }

        _computeStringLiterals() {
            return new TreeBag(new Set([this]), super._computeStringLiterals());
        }
    }

    class GetVars extends Expression {
        constructor(loc, variables) {
            // Reads of immutable variables are deterministic + side-effect-
            // free, so the load is unrestricted-at-substitution. Any mutable
            // var in the bundle taints the whole get to LINEAR.
            const opLin = variables.every(v => !v.mutable)
                ? 'UNRESTRICTED' : 'LINEAR';
            super(loc, variables.map(v => v.type), [], opLin);
            this.variables = variables; // Array of Variable
            this._finalize();
        }
    }

    class SetVars extends Expression {
        constructor(loc, variables, values) {
            // Validate first so we know whether to mark the node as divergent.
            // We need to call super before touching `this`, so collect the
            // errors and the divergent flag locally, then super(), then report.
            const anyDivergent = values.some(v => v.types === null);
            const errors = [];
            for (const v of variables) {
                if (!v.mutable) {
                    errors.push(`Cannot assign to immutable variable ${v.name}`);
                }
            }
            if (!anyDivergent) {
                const varTypes = variables.map(v => v.type);
                const valueTypes = values.flatMap(e => e.types);
                if (varTypes.length !== valueTypes.length) {
                    // Skip per-position checks when the count is wrong: positions
                    // are likely misaligned and the resulting errors would be
                    // misleading cascades that vanish once the count is fixed.
                    errors.push(`Value count mismatch: expected ${varTypes.length}, got ${valueTypes.length}`);
                } else {
                    for (let i = 0; i < varTypes.length; i++) {
                        if (!valueTypes[i].isAssignableTo(varTypes[i])) {
                            errors.push(`Value type mismatch at position ${i}: expected ${varTypes[i]}, got ${valueTypes[i]}`);
                        }
                    }
                }
            }
            // Divergent if a value diverged OR any validation error fired —
            // either way the actual store doesn't happen, and we don't want
            // the parent's type-checks to cascade off our type.
            const divergent = anyDivergent || errors.length > 0;
            super(loc, divergent ? null : [], values);
            this.variables = variables;
            this.values = values;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren(newChildren) {
            return new SetVars(this.loc, this.variables, newChildren);
        }
    }

    // TeeVars: assign and leave the values on the stack. Equivalent in
    // behavior to `SetVars(vars, [value]); GetVars(vars)`. For the common
    // case of a single LocalVariable, codegen emits `local.tee` (one byte +
    // index, vs `local.set` + `local.get` = two opcodes). Falls back to a
    // set+get sequence for globals or multi-variable cases.
    //
    // Like SetVars, the value's slot types must match the variables' types
    // in count and order. Result types = the variables' types.
    class TeeVars extends Expression {
        constructor(loc, variables, value) {
            const errors = [];
            const valueDivergent = value.types === null;
            for (const v of variables) {
                if (!v.mutable) {
                    errors.push(`Cannot assign to immutable variable ${v.name}`);
                }
            }
            if (!valueDivergent) {
                const varTypes = variables.map(v => v.type);
                const valueTypes = value.types;
                if (varTypes.length !== valueTypes.length) {
                    errors.push(`Value count mismatch: expected ${varTypes.length}, got ${valueTypes.length}`);
                } else {
                    for (let i = 0; i < varTypes.length; i++) {
                        if (!valueTypes[i].isAssignableTo(varTypes[i])) {
                            errors.push(`Value type mismatch at position ${i}: expected ${varTypes[i]}, got ${valueTypes[i]}`);
                        }
                    }
                }
            }
            const divergent = valueDivergent || errors.length > 0;
            const resultTypes = divergent ? null : variables.map(v => v.type);
            super(loc, resultTypes, [value]);
            this.variables = variables;
            this.value = value;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren(newChildren) {
            return new TeeVars(this.loc, this.variables, newChildren[0]);
        }
    }

    class FunctionCall extends Expression {
        constructor(loc, func, args) {
            // Validate first; mark divergent on any validation failure so the
            // error doesn't cascade to the parent's type checks.
            const anyDivergent = args.some(a => a.types === null);
            const errors = [];
            if (!anyDivergent) {
                const paramTypes = func.type.params;
                const argTypes = args.flatMap(arg => arg.types);
                if (paramTypes.length !== argTypes.length) {
                    errors.push(`Argument count mismatch: expected ${paramTypes.length}, got ${argTypes.length}`);
                } else {
                    for (let i = 0; i < paramTypes.length; i++) {
                        if (!argTypes[i].isAssignableTo(paramTypes[i])) {
                            errors.push(`Argument type mismatch at position ${i}: expected ${paramTypes[i]}, got ${argTypes[i]}`);
                        }
                    }
                }
            }
            const divergent = anyDivergent || errors.length > 0;
            super(loc, divergent ? null : func.type.results, args);
            this.func = func;
            this.args = args;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren(newChildren) {
            return new FunctionCall(this.loc, this.func, newChildren);
        }
    }

    // CallIndirect: dispatches through a table. The function-type is given
    // explicitly (must match the table entry's actual type at runtime — wasm
    // traps if it doesn't). `indexExpr` is the i32 table index. Args are
    // validated against the function-type's params.
    class CallIndirect extends Expression {
        constructor(loc, table, funcType, indexExpr, args) {
            const errors = [];
            let divergent = false;
            // `table === null` means "use the codegen-synthesized auto-table"
            // — the same one populated by IR.FuncIndex(f). Frontends that
            // want C-style function pointers don't have to construct a Table
            // themselves; they just emit FuncIndex + CallIndirect(null, …).
            if (table !== null && !(table instanceof Table)) {
                errors.push('CallIndirect: table must be an IR.Table or null (auto-table)');
                divergent = true;
            }
            if (!(funcType instanceof T.FunctionType)) {
                errors.push('CallIndirect: funcType must be a FunctionType');
                divergent = true;
            } else if (indexExpr.types === null ||
                       args.some(a => a.types === null)) {
                divergent = true;
            } else {
                if (indexExpr.types.length !== 1 ||
                    (indexExpr.types[0].slotType || indexExpr.types[0]) !== T.I32) {
                    errors.push('CallIndirect: index must be a single i32');
                    divergent = true;
                }
                const argTypes = args.flatMap(a => a.types);
                if (argTypes.length !== funcType.params.length) {
                    errors.push(
                        `CallIndirect: argument count mismatch ` +
                        `(expected ${funcType.params.length}, got ${argTypes.length})`);
                    divergent = true;
                } else {
                    for (let i = 0; i < argTypes.length; i++) {
                        if (!argTypes[i].isAssignableTo(funcType.params[i])) {
                            errors.push(
                                `CallIndirect: arg ${i} type mismatch ` +
                                `(expected ${funcType.params[i]}, got ${argTypes[i]})`);
                            divergent = true;
                        }
                    }
                }
            }
            super(loc, divergent ? null : funcType.results, [...args, indexExpr]);
            this.table = table;
            this.funcType = funcType;
            this.indexExpr = indexExpr;
            this.args = args;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.funcType
                ? new TreeBag(new Set([this.funcType]), inherited)
                : inherited;
        }
        _computeHasNullTableCallIndirect() {
            return this.table === null
                || super._computeHasNullTableCallIndirect();
        }
        _withChildren(newChildren) {
            const args = newChildren.slice(0, this.args.length);
            const indexExpr = newChildren[this.args.length];
            return new CallIndirect(this.loc, this.table, this.funcType, indexExpr, args);
        }
    }

    // RefFunc: produces a (ref <funcType>) for the given function. The
    // function must be "declared" for ref.func to validate; codegen
    // auto-emits a declarative element segment for everything seen via
    // RefFunc (in addition to any active segments). Function need not be
    // exported — just bubble-up via `referencedFunctions` and codegen
    // handles the declaration.
    class RefFunc extends Expression {
        constructor(loc, func) {
            super(loc, [T.refTypeOf(func.type, false)], [], 'UNRESTRICTED');
            this.func = func;
            this._finalize();
        }
        _computeReferencedTypes() {
            return new TreeBag(new Set([this.func.type]),
                super._computeReferencedTypes());
        }
        _computeReferencedFunctions() {
            return new TreeBag(new Set([this.func]),
                super._computeReferencedFunctions());
        }
    }

    // FuncIndex: produces an i32 (well, U32) holding the function's slot
    // number in an auto-managed funcref table. Used to implement C-style
    // function pointers — the value compares with `==`, lives in struct
    // fields, stores in linear memory, casts to/from `void*`, all as a
    // plain integer. To call through one, use `IR.CallIndirect` against
    // the auto-table (`autoFuncTable` returned by codegen, also the
    // default table when CallIndirect's `table` is null).
    //
    // Codegen owns table layout: it walks every reachable defined
    // function body's `tableReferencedFunctions`, allocates one unique
    // index per distinct function (starting at 1; index 0 is reserved as
    // the null function pointer), synthesizes a single funcref table +
    // active element segment, and emits each `FuncIndex(f)` as
    // `i32.const idx`. The auto-table is exported as
    // `__indirect_function_table` to match common C-toolchain ABIs.
    class FuncIndex extends Expression {
        constructor(loc, func) {
            super(loc, [T.U32], [], 'UNRESTRICTED');
            this.func = func;
            this._finalize();
        }
        _computeReferencedFunctions() {
            return new TreeBag(new Set([this.func]),
                super._computeReferencedFunctions());
        }
        _computeTableReferencedFunctions() {
            return new TreeBag(new Set([this.func]),
                super._computeTableReferencedFunctions());
        }
    }

    class BinOp extends Expression {
        constructor(loc, op, lhs, rhs) {
            const { resultTypes, errors } = BinOp._validate(op, lhs, rhs);
            // div/rem trap on zero divisor; everything else is unrestricted.
            const opLin = (op === 'div' || op === 'rem')
                ? 'LINEAR' : 'UNRESTRICTED';
            super(loc, resultTypes, [lhs, rhs], opLin);
            this.op = op;
            this.lhs = lhs;
            this.rhs = rhs;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([lhs, rhs]) {
            return new BinOp(this.loc, this.op, lhs, rhs);
        }

        // One pass: returns the result types if valid, plus any user-error
        // messages for the IR builder to feed to reportError. On any
        // validation failure resultTypes is `null` (divergent) so that the
        // error doesn't cascade — parents treat us as a broken op that never
        // executes, skip their own validation against us, and propagate
        // null upward. A divergent operand triggers the same path.
        static _validate(op, lhs, rhs) {
            if (lhs.types === null || rhs.types === null) {
                return { resultTypes: null, errors: [] };
            }
            const meta = OPS.BINOPS[op];
            if (!meta) return { resultTypes: null, errors: [`Unknown BinOp '${op}'`] };
            if (lhs.types.length !== 1 || rhs.types.length !== 1) {
                return { resultTypes: null, errors: [
                    `BinOp '${op}' requires single-value operands; ` +
                    `got ${lhs.types.length} and ${rhs.types.length}`,
                ]};
            }
            const t = lhs.types[0];
            const r = rhs.types[0];
            if (t !== r) {
                const tSlot = t.slotType || t;
                const rSlot = r.slotType || r;
                if (tSlot !== rSlot) {
                    return { resultTypes: null, errors: [
                        `BinOp '${op}' operand type mismatch: ${t} vs ${r}`,
                    ]};
                }
            }
            const slot = (t.slotType || t).name;
            let variant = op;
            if (meta.signed && t.isIntegralType()) variant += t.signed ? '_s' : '_u';
            if (!(`${slot}.${variant}` in meta.opcodes)) {
                return { resultTypes: null, errors: [`BinOp '${op}' is not defined for ${t}`] };
            }
            return {
                resultTypes: meta.result === 'i32' ? [T.I32] : [t],
                errors: [],
            };
        }
    }

    class UnaryOp extends Expression {
        constructor(loc, op, operand) {
            const { resultTypes, errors } = UnaryOp._validate(op, operand);
            super(loc, resultTypes, [operand], 'UNRESTRICTED');
            this.op = op;
            this.operand = operand;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([operand]) {
            return new UnaryOp(this.loc, this.op, operand);
        }

        static _validate(op, operand) {
            // Same null-on-error policy as BinOp — see that comment.
            if (operand.types === null) return { resultTypes: null, errors: [] };
            const meta = OPS.UNARYOPS[op];
            if (!meta) return { resultTypes: null, errors: [`Unknown UnaryOp '${op}'`] };
            if (operand.types.length !== 1) {
                return { resultTypes: null, errors: [
                    `UnaryOp '${op}' requires a single-value operand; ` +
                    `got ${operand.types.length}`,
                ]};
            }
            const t = operand.types[0];
            const slot = (t.slotType || t).name;
            if (!(`${slot}.${op}` in meta.opcodes)) {
                return { resultTypes: null, errors: [`UnaryOp '${op}' is not defined for ${t}`] };
            }
            return {
                resultTypes: meta.result === 'i32' ? [T.I32] : [t],
                errors: [],
            };
        }
    }

    // Convert: a wasm numeric conversion (wrap/extend/trunc/convert/demote/
    // promote/reinterpret). The op name matches wasm 1:1 (e.g.
    // 'i64.extend_i32_s'), making the operand slot and result type explicit.
    // The operand's IR-type may be unsigned (e.g. U32 for an op expecting i32
    // slot) — only the wasm slot has to match.
    // Trap-on-NaN/out-of-range trunc conversions; everything else (extend,
    // wrap, demote, promote, reinterpret, convert) is total + deterministic.
    const _TRAPPING_CONVERTS = new Set([
        'i32.trunc_f32_s', 'i32.trunc_f32_u',
        'i32.trunc_f64_s', 'i32.trunc_f64_u',
        'i64.trunc_f32_s', 'i64.trunc_f32_u',
        'i64.trunc_f64_s', 'i64.trunc_f64_u',
    ]);

    class Convert extends Expression {
        constructor(loc, op, source) {
            const { resultTypes, errors } = Convert._validate(op, source);
            const opLin = _TRAPPING_CONVERTS.has(op)
                ? 'LINEAR' : 'UNRESTRICTED';
            super(loc, resultTypes, [source], opLin);
            this.op = op;
            this.source = source;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([source]) {
            return new Convert(this.loc, this.op, source);
        }

        static _validate(op, source) {
            if (source.types === null) return { resultTypes: null, errors: [] };
            const meta = OPS.CONVERSIONS[op];
            if (!meta) return { resultTypes: null, errors: [`Unknown Convert '${op}'`] };
            if (source.types.length !== 1) {
                return { resultTypes: null, errors: [
                    `Convert '${op}' requires a single-value operand; ` +
                    `got ${source.types.length}`,
                ]};
            }
            const t = source.types[0];
            const slot = (t.slotType || t).name;
            if (slot !== meta.operandSlot) {
                return { resultTypes: null, errors: [
                    `Convert '${op}' expects operand slot ${meta.operandSlot}; got ${t} (slot ${slot})`,
                ]};
            }
            return { resultTypes: [meta.result], errors: [] };
        }
    }

    // Load: read a value from linear memory. `op` is the wasm op name
    // (e.g. 'i32.load', 'i32.load8_s'). `addr` must produce a single i32
    // (the byte offset into memory). `options` may include:
    //   - offset: u32, added to addr at runtime (default 0)
    //   - align: log2(bytes), default = the op's natural alignment
    class Load extends Expression {
        constructor(loc, op, addr, options) {
            const opts = options || {};
            const meta = OPS.LOADS[op];
            const offset = opts.offset !== undefined ? opts.offset : 0;
            const align = opts.align !== undefined ? opts.align
                        : (meta ? meta.naturalAlign : 0);
            const errors = [];
            let resultTypes = null;
            if (!meta) {
                errors.push(`Unknown Load op '${op}'`);
            } else if (addr.types === null) {
                // divergent operand → propagate
            } else if (addr.types.length !== 1 ||
                       (addr.types[0].slotType || addr.types[0]) !== T.I32) {
                errors.push(
                    `Load '${op}' address must produce a single i32; ` +
                    `got (${addr.types.map(String).join(', ')})`);
            } else {
                resultTypes = [meta.result];
            }
            super(loc, resultTypes, [addr]);
            this.op = op;
            this.addr = addr;
            this.offset = offset;
            this.align = align;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([addr]) {
            return new Load(this.loc, this.op, addr,
                { offset: this.offset, align: this.align });
        }
    }

    // Store: write a value to linear memory. `op` is the wasm op name
    // (e.g. 'i32.store', 'i32.store8'). `addr` must produce i32; `value`'s
    // wasm slot must match the op's `valueSlot`. Sub-i32 stores truncate.
    // Result type is [].
    class Store extends Expression {
        constructor(loc, op, addr, value, options) {
            const opts = options || {};
            const meta = OPS.STORES[op];
            const offset = opts.offset !== undefined ? opts.offset : 0;
            const align = opts.align !== undefined ? opts.align
                        : (meta ? meta.naturalAlign : 0);
            const errors = [];
            let divergent = false;
            if (!meta) {
                errors.push(`Unknown Store op '${op}'`);
                divergent = true;
            } else if (addr.types === null || value.types === null) {
                divergent = true;
            } else if (addr.types.length !== 1 ||
                       (addr.types[0].slotType || addr.types[0]) !== T.I32) {
                errors.push(`Store '${op}' address must produce a single i32`);
                divergent = true;
            } else if (value.types.length !== 1) {
                errors.push(`Store '${op}' value must be single-valued`);
                divergent = true;
            } else {
                const vt = value.types[0];
                const vSlot = (vt.slotType || vt).name;
                if (vSlot !== meta.valueSlot) {
                    errors.push(
                        `Store '${op}' expects value slot ${meta.valueSlot}; ` +
                        `got ${vt} (slot ${vSlot})`);
                    divergent = true;
                }
            }
            super(loc, divergent ? null : [], [addr, value]);
            this.op = op;
            this.addr = addr;
            this.value = value;
            this.offset = offset;
            this.align = align;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([addr, value]) {
            return new Store(this.loc, this.op, addr, value,
                { offset: this.offset, align: this.align });
        }
    }

    // MemorySize: returns the current size of the default memory in pages.
    class MemorySize extends Expression {
        constructor(loc) {
            // Returns the current memory size in pages — a value that can
            // change after a memory.grow elsewhere, but within a body that
            // doesn't grow memory it's effectively constant. UNRESTRICTED
            // for substitution purposes (the inliner's simple-body
            // whitelist excludes MemoryGrow).
            super(loc, [T.I32], [], 'UNRESTRICTED');
            this._finalize();
        }
    }

    // MemoryGrow: grow the default memory by `delta` pages. Returns the
    // previous size in pages, or -1 on failure. `delta` must be a single i32.
    class MemoryGrow extends Expression {
        constructor(loc, delta) {
            const errors = [];
            let resultTypes = [T.I32];
            if (delta.types === null) {
                resultTypes = null;
            } else if (delta.types.length !== 1 ||
                       (delta.types[0].slotType || delta.types[0]) !== T.I32) {
                errors.push(`MemoryGrow delta must produce a single i32`);
                resultTypes = null;
            }
            super(loc, resultTypes, [delta]);
            this.delta = delta;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([delta]) {
            return new MemoryGrow(this.loc, delta);
        }
    }

    // Helper: validate that a list of operand expressions all produce a
    // single i32. Returns true if any operand is divergent or wrong-typed
    // (caller should mark the parent divergent in that case).
    function _validateI32Operands(exprs, errors, opName) {
        let bad = false;
        for (const [name, e] of exprs) {
            if (e.types === null) { bad = true; continue; }
            if (e.types.length !== 1 || (e.types[0].slotType || e.types[0]) !== T.I32) {
                errors.push(`${opName} ${name} must produce a single i32`);
                bad = true;
            }
        }
        return bad;
    }

    // MemoryCopy: memmove-equivalent on linear memory. Copies `n` bytes from
    // `src` to `dst`; overlapping regions are handled correctly per spec.
    // All three operands are i32 (byte count, byte addresses).
    class MemoryCopy extends Expression {
        constructor(loc, dst, src, n) {
            const errors = [];
            const divergent = _validateI32Operands(
                [['dst', dst], ['src', src], ['n', n]], errors, 'MemoryCopy');
            super(loc, divergent ? null : [], [dst, src, n]);
            this.dst = dst;
            this.src = src;
            this.n = n;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([dst, src, n]) {
            return new MemoryCopy(this.loc, dst, src, n);
        }
    }

    // MemoryFill: memset on linear memory. Writes `n` copies of the low byte
    // of `val` starting at `dst`.
    class MemoryFill extends Expression {
        constructor(loc, dst, val, n) {
            const errors = [];
            const divergent = _validateI32Operands(
                [['dst', dst], ['val', val], ['n', n]], errors, 'MemoryFill');
            super(loc, divergent ? null : [], [dst, val, n]);
            this.dst = dst;
            this.val = val;
            this.n = n;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([dst, val, n]) {
            return new MemoryFill(this.loc, dst, val, n);
        }
    }

    // BytesLiteral: an immutable byte sequence laid out in linear memory by
    // the codegen. The expression's value is the i32 address of the start of
    // the blob. Codegen deduplicates BytesLiterals by content.
    class BytesLiteral extends Expression {
        constructor(loc, bytes) {
            // Resolves to a constant i32 address at codegen time.
            super(loc, [T.I32], [], 'UNRESTRICTED');
            // We copy the input so the caller's array can't mutate ours, but
            // typed-array views cannot themselves be frozen — by convention,
            // do not mutate `bl.bytes` after construction.
            this.bytes = new Uint8Array(bytes);
            this._finalize();
        }

        _computeBytesLiterals() {
            return new TreeBag(new Set([this]), super._computeBytesLiterals());
        }
    }

    // MutableBytesLiteral: like BytesLiteral but each instance gets its OWN
    // address (no content-dedup), and the laid-out region is intended to be
    // mutated at runtime via Store/MemoryFill/MemoryCopy. The address is a
    // constant i32; codegen places the bytes in an active data segment in
    // the same static-data region as BytesLiterals.
    class MutableBytesLiteral extends Expression {
        constructor(loc, bytes, name) {
            super(loc, [T.I32], [], 'UNRESTRICTED');
            this.bytes = new Uint8Array(bytes);
            this.name = name || null; // optional, for debugging only
            this._finalize();
        }

        _computeBytesLiterals() {
            return new TreeBag(new Set([this]), super._computeBytesLiterals());
        }
    }

    // StackSlot: an identity object representing a fixed-size, fixed-align
    // region in the stack frame. Not an Expression — it has no value on the
    // wasm stack. Address it via IR.StackSlotAddr(slot). Codegen assigns
    // each slot an offset within its enclosing FrameNode at layout time.
    class StackSlot {
        constructor(name, size, align) {
            this.name = name;
            this.size = size;     // bytes
            this.align = align;   // bytes (power of 2)
            assert(typeof size === 'number' && size >= 0,
                () => `StackSlot ${name}: size must be a non-negative number`);
            assert(typeof align === 'number' && align >= 1 &&
                (align & (align - 1)) === 0,
                () => `StackSlot ${name}: align must be a power of 2`);
            Object.freeze(this);
        }
    }

    // StackSlotAddr: the i32 address of a StackSlot in the current frame.
    // Address-frame-stable: codegen emits `global.get $sp; i32.const $off;
    // i32.add` (where $off is the slot's offset assigned by frame layout).
    // UNRESTRICTED — pure address arithmetic.
    class StackSlotAddr extends Expression {
        constructor(loc, slot) {
            assert(slot instanceof StackSlot,
                'StackSlotAddr: slot must be a StackSlot');
            super(loc, [T.I32], [], 'UNRESTRICTED');
            this.slot = slot;
            this._finalize();
        }

        _computeUnclaimedSlots() {
            return new TreeBag(new Set([this.slot]),
                super._computeUnclaimedSlots());
        }
    }

    // Alloca: dynamic stack allocation. Bumps the stack pointer down by
    // `align`-rounded `size` bytes and returns the new top-of-stack as an
    // i32 address. The region is valid until the function returns (the
    // function-level prologue/epilogue restores SP). LINEAR — has SP
    // side-effect.
    //
    // `size` may be either a number (static — codegen embeds it as an
    // i32.const) or an Expression of single-i32 type (dynamic — codegen
    // computes the size at runtime). In both cases `align` is static.
    class Alloca extends Expression {
        constructor(loc, size, align) {
            const sizeIsExpr = size instanceof Expression;
            const errors = [];
            if (!sizeIsExpr) {
                assert(typeof size === 'number' && size >= 0,
                    () => `Alloca: size must be a non-negative number or Expression`);
            } else if (size.types !== null) {
                if (size.types.length !== 1 ||
                    (size.types[0].slotType || size.types[0]) !== T.I32) {
                    errors.push('Alloca: dynamic size must produce a single i32');
                }
            }
            assert(typeof align === 'number' && align >= 1 &&
                (align & (align - 1)) === 0,
                () => `Alloca: align must be a power of 2`);
            super(loc, [T.I32], sizeIsExpr ? [size] : [], 'LINEAR');
            this.size = size;
            this.align = align;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }

        _computeContainsAlloca() { return true; }

        _withChildren(newChildren) {
            // size is the only child when dynamic; nothing to rewire when
            // static.
            const newSize = newChildren.length === 0 ? this.size : newChildren[0];
            return new Alloca(this.loc, newSize, this.align);
        }
    }

    // HeapBase: the i32 address of the start of the heap region (i.e. the
    // first byte after the static-data and stack regions). Resolves to a
    // constant i32 at codegen time, after layout determines its value.
    // UNRESTRICTED — pure constant.
    class HeapBase extends Expression {
        constructor(loc) {
            super(loc, [T.I32], [], 'UNRESTRICTED');
            this._finalize();
        }
    }

    // FrameNode: a tree node representing a lexical scope's stack frame.
    // Built bottom-up at Block construction. `ownSlots` are slots claimed
    // directly at this scope (i.e. slots from non-Block descendants and
    // slots not claimed by any inner Block); `children` are FrameNodes for
    // each enclosed Block scope. Layout walks this tree depth-first; each
    // FrameNode's children are siblings whose storage can overlay (max not
    // sum), enabling stack coloring across disjoint scopes.
    class FrameNode {
        constructor(owner, ownSlots, children) {
            this.owner = owner;       // Block | null (synthetic root)
            this.ownSlots = ownSlots; // Array<StackSlot>
            this.children = children; // Array<FrameNode>
            Object.freeze(this.ownSlots);
            Object.freeze(this.children);
            Object.freeze(this);
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Wasm GC ops — all ops that take or produce a concrete heap type seed
    // their type into `referencedTypes` so the codegen pre-pass can include
    // it in the type section (transitively). Result types use the
    // (interned) `refTypeOf(heap, nullable)` so locals/globals of struct or
    // array refs hash the same way regardless of construction site.
    // ─────────────────────────────────────────────────────────────────────

    // Helper: determine whether a value's IR type can be stored into a struct
    // field or array element. For packed slots (`packedKind: 'i8'/'i16'`) we
    // accept any i32-slotted IR type. For non-packed, standard isAssignableTo.
    function _valueFitsField(valueType, field) {
        if (field.packedKind) {
            const slot = valueType.slotType || valueType;
            return slot === T.I32;
        }
        return valueType.isAssignableTo(field.type);
    }

    class StructNew extends Expression {
        constructor(loc, structType, fieldValues) {
            const errors = [];
            let divergent = false;
            if (!(structType instanceof T.StructType)) {
                errors.push('StructNew: type must be a StructType');
                divergent = true;
            } else if (fieldValues.length !== structType.fields.length) {
                errors.push(
                    `StructNew: expected ${structType.fields.length} fields, ` +
                    `got ${fieldValues.length}`);
                divergent = true;
            } else {
                for (let i = 0; i < fieldValues.length; i++) {
                    const v = fieldValues[i], f = structType.fields[i];
                    if (v.types === null) { divergent = true; continue; }
                    if (v.types.length !== 1) {
                        errors.push(`StructNew: field ${i} expects single value`);
                        divergent = true;
                        continue;
                    }
                    if (!_valueFitsField(v.types[0], f)) {
                        errors.push(
                            `StructNew: field ${i} type mismatch ` +
                            `(expected ${f.packedKind || f.type}, got ${v.types[0]})`);
                        divergent = true;
                    }
                }
            }
            const resultTypes = divergent
                ? null : [T.refTypeOf(structType, false)];
            super(loc, resultTypes, fieldValues);
            this.structType = structType;
            this.fieldValues = fieldValues;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.structType
                ? new TreeBag(new Set([this.structType]), inherited)
                : inherited;
        }
        _withChildren(newChildren) {
            return new StructNew(this.loc, this.structType, newChildren);
        }
    }

    class StructGet extends Expression {
        // signed: undefined for non-packed, true/false for packed (selects
        // struct.get_s vs struct.get_u). Field's packedKind decides whether
        // the signed parameter is required.
        constructor(loc, structType, fieldIdx, ref, signed) {
            const errors = [];
            let resultTypes = null;
            let field = null;
            if (!(structType instanceof T.StructType)) {
                errors.push('StructGet: type must be a StructType');
            } else if (fieldIdx < 0 || fieldIdx >= structType.fields.length) {
                errors.push(`StructGet: field index ${fieldIdx} out of range`);
            } else {
                field = structType.fields[fieldIdx];
                if (ref.types === null) {
                    // divergent
                } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                    errors.push('StructGet: ref must be a single RefType value');
                } else if (field.packedKind && (signed !== true && signed !== false)) {
                    errors.push(
                        `StructGet: packed field ${fieldIdx} (${field.packedKind}) ` +
                        `requires explicit signed=true|false`);
                } else if (!field.packedKind && signed !== undefined) {
                    errors.push(
                        `StructGet: non-packed field ${fieldIdx} should not pass a signed flag`);
                } else {
                    if (field.packedKind === 'i8') {
                        resultTypes = [signed ? T.I8 : T.U8];
                    } else if (field.packedKind === 'i16') {
                        resultTypes = [signed ? T.I16 : T.U16];
                    } else {
                        resultTypes = [field.type];
                    }
                }
            }
            super(loc, resultTypes, [ref]);
            this.structType = structType;
            this.fieldIdx = fieldIdx;
            this.ref = ref;
            this.signed = signed;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.structType
                ? new TreeBag(new Set([this.structType]), inherited)
                : inherited;
        }
        _withChildren([ref]) {
            return new StructGet(this.loc, this.structType, this.fieldIdx, ref, this.signed);
        }
    }

    class StructSet extends Expression {
        constructor(loc, structType, fieldIdx, ref, value) {
            const errors = [];
            let divergent = false;
            if (!(structType instanceof T.StructType)) {
                errors.push('StructSet: type must be a StructType');
                divergent = true;
            } else if (fieldIdx < 0 || fieldIdx >= structType.fields.length) {
                errors.push(`StructSet: field index ${fieldIdx} out of range`);
                divergent = true;
            } else {
                const field = structType.fields[fieldIdx];
                if (!field.mutable) {
                    errors.push(`StructSet: field ${fieldIdx} is not mutable`);
                    divergent = true;
                }
                if (ref.types === null || value.types === null) {
                    divergent = true;
                } else {
                    if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                        errors.push('StructSet: ref must be a single RefType value');
                        divergent = true;
                    }
                    if (value.types.length !== 1) {
                        errors.push(`StructSet: value must be single-valued`);
                        divergent = true;
                    } else if (!_valueFitsField(value.types[0], field)) {
                        errors.push(
                            `StructSet: value type mismatch ` +
                            `(expected ${field.packedKind || field.type}, got ${value.types[0]})`);
                        divergent = true;
                    }
                }
            }
            super(loc, divergent ? null : [], [ref, value]);
            this.structType = structType;
            this.fieldIdx = fieldIdx;
            this.ref = ref;
            this.value = value;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.structType
                ? new TreeBag(new Set([this.structType]), inherited)
                : inherited;
        }
        _withChildren([ref, value]) {
            return new StructSet(this.loc, this.structType, this.fieldIdx, ref, value);
        }
    }

    // True iff a type is "defaultable": numeric types and *nullable* refs.
    // Wasm GC requires every field/element to be defaultable for the
    // `_default` constructors (the runtime fills them with 0 / null).
    function _isDefaultable(t) {
        if (t instanceof T.IntegralType || t instanceof T.FloatingPointType) return true;
        if (t === T.EXTERNREF || t === T.FUNCREF) return true;
        if (t instanceof T.RefType) return t.nullable;
        return false;
    }

    // Recognize ref-typed values from BOTH the new GC RefType machinery and
    // the older PrimitiveType singletons (EXTERNREF/REFEXTERN/FUNCREF) we
    // had before RefType was added. Returns the nullability for ref types,
    // or `null` if `t` isn't a ref at all.
    function _refNullability(t) {
        if (t instanceof T.RefType) return t.nullable;
        if (t === T.EXTERNREF || t === T.FUNCREF) return true;  // nullable shorthands
        if (t === T.REFEXTERN) return false;                    // non-null shorthand
        return null;
    }

    class StructNewDefault extends Expression {
        constructor(loc, structType) {
            const errors = [];
            let resultTypes = null;
            if (!(structType instanceof T.StructType)) {
                errors.push('StructNewDefault: type must be a StructType');
            } else {
                const bad = structType.fields.findIndex(f =>
                    !f.packedKind && !_isDefaultable(f.type));
                if (bad >= 0) {
                    errors.push(
                        `StructNewDefault: field ${bad} is not defaultable ` +
                        `(non-nullable ref or other non-zero-init type)`);
                } else {
                    resultTypes = [T.refTypeOf(structType, false)];
                }
            }
            super(loc, resultTypes, []);
            this.structType = structType;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.structType
                ? new TreeBag(new Set([this.structType]), inherited)
                : inherited;
        }
    }

    class ArrayNew extends Expression {
        // array.new typeidx — fills `length` elements with `init`.
        constructor(loc, arrayType, init, length) {
            const errors = [];
            let divergent = false;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArrayNew: type must be an ArrayType');
                divergent = true;
            } else if (init.types === null || length.types === null) {
                divergent = true;
            } else {
                if (init.types.length !== 1 ||
                    !_valueFitsField(init.types[0],
                        { type: arrayType.elementType, packedKind: arrayType.packedKind })) {
                    errors.push(
                        `ArrayNew: init type mismatch (expected ` +
                        `${arrayType.packedKind || arrayType.elementType}, got ${init.types[0]})`);
                    divergent = true;
                }
                if (length.types.length !== 1 ||
                    (length.types[0].slotType || length.types[0]) !== T.I32) {
                    errors.push('ArrayNew: length must be a single i32');
                    divergent = true;
                }
            }
            const resultTypes = divergent ? null : [T.refTypeOf(arrayType, false)];
            super(loc, resultTypes, [init, length]);
            this.arrayType = arrayType;
            this.init = init;
            this.length = length;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren([init, length]) {
            return new ArrayNew(this.loc, this.arrayType, init, length);
        }
    }

    class ArrayNewDefault extends Expression {
        // array.new_default typeidx — length operand only; elements are
        // zero/null-initialized. Element type must be defaultable.
        constructor(loc, arrayType, length) {
            const errors = [];
            let resultTypes = null;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArrayNewDefault: type must be an ArrayType');
            } else if (!arrayType.packedKind && !_isDefaultable(arrayType.elementType)) {
                errors.push(
                    'ArrayNewDefault: element type is not defaultable ' +
                    '(non-nullable ref or other non-zero-init type)');
            } else if (length.types === null) {
                // divergent
            } else if (length.types.length !== 1 ||
                       (length.types[0].slotType || length.types[0]) !== T.I32) {
                errors.push('ArrayNewDefault: length must be a single i32');
            } else {
                resultTypes = [T.refTypeOf(arrayType, false)];
            }
            super(loc, resultTypes, [length]);
            this.arrayType = arrayType;
            this.length = length;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren([length]) {
            return new ArrayNewDefault(this.loc, this.arrayType, length);
        }
    }

    class ArrayNewFixed extends Expression {
        // array.new_fixed typeidx N — pops N values matching the element
        // type and produces an array of exactly that length. Useful for
        // `[1, 2, 3]`-style array literals.
        constructor(loc, arrayType, values) {
            const errors = [];
            let divergent = false;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArrayNewFixed: type must be an ArrayType');
                divergent = true;
            } else {
                for (let i = 0; i < values.length; i++) {
                    const v = values[i];
                    if (v.types === null) { divergent = true; continue; }
                    if (v.types.length !== 1 ||
                        !_valueFitsField(v.types[0],
                            { type: arrayType.elementType, packedKind: arrayType.packedKind })) {
                        errors.push(
                            `ArrayNewFixed: value ${i} type mismatch ` +
                            `(expected ${arrayType.packedKind || arrayType.elementType}, ` +
                            `got ${v.types && v.types[0]})`);
                        divergent = true;
                    }
                }
            }
            const resultTypes = divergent ? null : [T.refTypeOf(arrayType, false)];
            super(loc, resultTypes, values);
            this.arrayType = arrayType;
            this.values = values;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren(newChildren) {
            return new ArrayNewFixed(this.loc, this.arrayType, newChildren);
        }
    }

    class ArrayGet extends Expression {
        constructor(loc, arrayType, ref, index, signed) {
            const errors = [];
            let resultTypes = null;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArrayGet: type must be an ArrayType');
            } else if (ref.types === null || index.types === null) {
                // divergent
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('ArrayGet: ref must be a single RefType value');
            } else if (index.types.length !== 1 ||
                       (index.types[0].slotType || index.types[0]) !== T.I32) {
                errors.push('ArrayGet: index must be a single i32');
            } else if (arrayType.packedKind && signed !== true && signed !== false) {
                errors.push(
                    `ArrayGet: packed array (${arrayType.packedKind}) ` +
                    `requires explicit signed=true|false`);
            } else if (!arrayType.packedKind && signed !== undefined) {
                errors.push('ArrayGet: non-packed array should not pass a signed flag');
            } else {
                if (arrayType.packedKind === 'i8') {
                    resultTypes = [signed ? T.I8 : T.U8];
                } else if (arrayType.packedKind === 'i16') {
                    resultTypes = [signed ? T.I16 : T.U16];
                } else {
                    resultTypes = [arrayType.elementType];
                }
            }
            super(loc, resultTypes, [ref, index]);
            this.arrayType = arrayType;
            this.ref = ref;
            this.index = index;
            this.signed = signed;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren([ref, index]) {
            return new ArrayGet(this.loc, this.arrayType, ref, index, this.signed);
        }
    }

    class ArraySet extends Expression {
        constructor(loc, arrayType, ref, index, value) {
            const errors = [];
            let divergent = false;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArraySet: type must be an ArrayType');
                divergent = true;
            } else if (!arrayType.mutable) {
                errors.push('ArraySet: array is not mutable');
                divergent = true;
            } else if (ref.types === null || index.types === null || value.types === null) {
                divergent = true;
            } else {
                if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                    errors.push('ArraySet: ref must be a single RefType value');
                    divergent = true;
                }
                if (index.types.length !== 1 ||
                    (index.types[0].slotType || index.types[0]) !== T.I32) {
                    errors.push('ArraySet: index must be a single i32');
                    divergent = true;
                }
                if (value.types.length !== 1 ||
                    !_valueFitsField(value.types[0],
                        { type: arrayType.elementType, packedKind: arrayType.packedKind })) {
                    errors.push(
                        `ArraySet: value type mismatch (expected ` +
                        `${arrayType.packedKind || arrayType.elementType}, got ${value.types && value.types[0]})`);
                    divergent = true;
                }
            }
            super(loc, divergent ? null : [], [ref, index, value]);
            this.arrayType = arrayType;
            this.ref = ref;
            this.index = index;
            this.value = value;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren([ref, index, value]) {
            return new ArraySet(this.loc, this.arrayType, ref, index, value);
        }
    }

    class ArrayLen extends Expression {
        constructor(loc, ref) {
            const errors = [];
            let resultTypes = [T.I32];
            if (ref.types === null) {
                resultTypes = null;
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('ArrayLen: ref must be a single RefType value');
                resultTypes = null;
            }
            super(loc, resultTypes, [ref]);
            this.ref = ref;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([ref]) {
            return new ArrayLen(this.loc, ref);
        }
    }

    class ArrayCopy extends Expression {
        // array.copy dstType srcType — copies n elements between arrays;
        // overlap-safe per spec (memmove). dstType element must accept
        // srcType element; both packedKinds must match.
        constructor(loc, dstType, srcType, dst, dstOffset, src, srcOffset, n) {
            const errors = [];
            let divergent = false;
            if (!(dstType instanceof T.ArrayType) || !(srcType instanceof T.ArrayType)) {
                errors.push('ArrayCopy: dstType and srcType must be ArrayTypes');
                divergent = true;
            } else if (!dstType.mutable) {
                errors.push('ArrayCopy: destination array is not mutable');
                divergent = true;
            } else if ([dst, dstOffset, src, srcOffset, n].some(e => e.types === null)) {
                divergent = true;
            } else {
                if ((srcType.packedKind || null) !== (dstType.packedKind || null)) {
                    errors.push(
                        `ArrayCopy: src/dst packed kinds must match ` +
                        `(src=${srcType.packedKind || 'unpacked'}, ` +
                        `dst=${dstType.packedKind || 'unpacked'})`);
                    divergent = true;
                } else if (!srcType.elementType.isAssignableTo(dstType.elementType)) {
                    errors.push(
                        `ArrayCopy: src element type ${srcType.elementType} ` +
                        `not assignable to dst element type ${dstType.elementType}`);
                    divergent = true;
                }
                for (const [name, e] of [['dst', dst], ['src', src]]) {
                    if (e.types.length !== 1 || !(e.types[0] instanceof T.RefType)) {
                        errors.push(`ArrayCopy: ${name} must be a single RefType value`);
                        divergent = true;
                    }
                }
                for (const [name, e] of [
                    ['dstOffset', dstOffset], ['srcOffset', srcOffset], ['n', n],
                ]) {
                    if (e.types.length !== 1 ||
                        (e.types[0].slotType || e.types[0]) !== T.I32) {
                        errors.push(`ArrayCopy: ${name} must be a single i32`);
                        divergent = true;
                    }
                }
            }
            super(loc, divergent ? null : [], [dst, dstOffset, src, srcOffset, n]);
            this.dstType = dstType;
            this.srcType = srcType;
            this.dst = dst;
            this.dstOffset = dstOffset;
            this.src = src;
            this.srcOffset = srcOffset;
            this.n = n;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            const set = new Set();
            if (this.dstType instanceof T.ArrayType) set.add(this.dstType);
            if (this.srcType instanceof T.ArrayType) set.add(this.srcType);
            return new TreeBag(set, inherited);
        }
        _withChildren([dst, dstOffset, src, srcOffset, n]) {
            return new ArrayCopy(this.loc, this.dstType, this.srcType,
                dst, dstOffset, src, srcOffset, n);
        }
    }

    class ArrayFill extends Expression {
        // array.fill arrayType — writes `val` into [offset, offset + n).
        constructor(loc, arrayType, ref, offset, val, n) {
            const errors = [];
            let divergent = false;
            if (!(arrayType instanceof T.ArrayType)) {
                errors.push('ArrayFill: type must be an ArrayType');
                divergent = true;
            } else if (!arrayType.mutable) {
                errors.push('ArrayFill: array is not mutable');
                divergent = true;
            } else if ([ref, offset, val, n].some(e => e.types === null)) {
                divergent = true;
            } else {
                if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                    errors.push('ArrayFill: ref must be a single RefType value');
                    divergent = true;
                }
                for (const [name, e] of [['offset', offset], ['n', n]]) {
                    if (e.types.length !== 1 ||
                        (e.types[0].slotType || e.types[0]) !== T.I32) {
                        errors.push(`ArrayFill: ${name} must be a single i32`);
                        divergent = true;
                    }
                }
                if (val.types.length !== 1 ||
                    !_valueFitsField(val.types[0],
                        { type: arrayType.elementType, packedKind: arrayType.packedKind })) {
                    errors.push(
                        `ArrayFill: val type mismatch (expected ` +
                        `${arrayType.packedKind || arrayType.elementType}, ` +
                        `got ${val.types && val.types[0]})`);
                    divergent = true;
                }
            }
            super(loc, divergent ? null : [], [ref, offset, val, n]);
            this.arrayType = arrayType;
            this.ref = ref;
            this.offset = offset;
            this.val = val;
            this.n = n;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            return this.arrayType
                ? new TreeBag(new Set([this.arrayType]), inherited)
                : inherited;
        }
        _withChildren([ref, offset, val, n]) {
            return new ArrayFill(this.loc, this.arrayType, ref, offset, val, n);
        }
    }

    // any.convert_extern: takes (ref null? extern), produces (ref null? any).
    // Same nullability. Constant-time tag conversion at runtime — the
    // engine just retags the reference; no allocation, no copy.
    class AnyConvertExtern extends Expression {
        constructor(loc, ref) {
            const errors = [];
            let resultTypes = null;
            if (ref.types === null) {
                // divergent
            } else if (ref.types.length !== 1) {
                errors.push('AnyConvertExtern: operand must be single-valued');
            } else {
                const nullable = _refNullability(ref.types[0]);
                if (nullable === null) {
                    errors.push(
                        `AnyConvertExtern: operand must be a ref type; ` +
                        `got ${ref.types[0]}`);
                } else {
                    resultTypes = [T.refTypeOf(T.HEAP_ANY, nullable)];
                }
            }
            super(loc, resultTypes, [ref], 'UNRESTRICTED');
            this.ref = ref;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([ref]) {
            return new AnyConvertExtern(this.loc, ref);
        }
    }

    // extern.convert_any: takes (ref null? any), produces (ref null? extern).
    // The mirror of AnyConvertExtern.
    class ExternConvertAny extends Expression {
        constructor(loc, ref) {
            const errors = [];
            let resultTypes = null;
            if (ref.types === null) {
                // divergent
            } else if (ref.types.length !== 1) {
                errors.push('ExternConvertAny: operand must be single-valued');
            } else {
                const nullable = _refNullability(ref.types[0]);
                if (nullable === null) {
                    errors.push(
                        `ExternConvertAny: operand must be a ref type; ` +
                        `got ${ref.types[0]}`);
                } else {
                    resultTypes = [T.refTypeOf(T.HEAP_EXTERN, nullable)];
                }
            }
            super(loc, resultTypes, [ref], 'UNRESTRICTED');
            this.ref = ref;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([ref]) {
            return new ExternConvertAny(this.loc, ref);
        }
    }

    // ref.null heaptype — produces a null reference of the given heap type.
    class RefNull extends Expression {
        constructor(loc, heapType) {
            super(loc, [T.refTypeOf(heapType, true)], [], 'UNRESTRICTED');
            this.heapType = heapType;
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            // Only concrete heap types need type-section registration.
            if (this.heapType instanceof T.StructType ||
                this.heapType instanceof T.ArrayType ||
                this.heapType instanceof T.FunctionType) {
                return new TreeBag(new Set([this.heapType]), inherited);
            }
            return inherited;
        }
    }

    class RefIsNull extends Expression {
        constructor(loc, ref) {
            const errors = [];
            let resultTypes = [T.I32];
            if (ref.types === null) {
                resultTypes = null;
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('RefIsNull: operand must be a single RefType value');
                resultTypes = null;
            }
            super(loc, resultTypes, [ref], 'UNRESTRICTED');
            this.ref = ref;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([ref]) {
            return new RefIsNull(this.loc, ref);
        }
    }

    // RefAsNonNull: takes (ref null T) and produces (ref T), trapping at
    // runtime if the value is null. Single-byte opcode 0xD4.
    class RefAsNonNull extends Expression {
        constructor(loc, ref) {
            const errors = [];
            let resultTypes = null;
            if (ref.types === null) {
                // divergent
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('RefAsNonNull: operand must be a single RefType value');
            } else {
                resultTypes = [T.refTypeOf(ref.types[0].heapType, false)];
            }
            super(loc, resultTypes, [ref]);
            this.ref = ref;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([ref]) {
            return new RefAsNonNull(this.loc, ref);
        }
    }

    // RefEq: reference equality on two `eqref`-compatible refs. Single-byte
    // opcode 0xD3. Result is i32 (0 or 1). Both operands must be assignable
    // to `(ref null eq)` — i.e., heap type i31, struct, or array (or a
    // subtype thereof), nullable or not.
    class RefEq extends Expression {
        constructor(loc, refA, refB) {
            const errors = [];
            let resultTypes = [T.I32];
            const anyDivergent = refA.types === null || refB.types === null;
            if (anyDivergent) {
                resultTypes = null;
            } else {
                const eqRef = T.refTypeOf(T.HEAP_EQ, true);
                const check = (operand, label) => {
                    if (operand.types.length !== 1
                        || !(operand.types[0] instanceof T.RefType)
                        || !operand.types[0].isAssignableTo(eqRef)) {
                        errors.push(
                            `RefEq: ${label} operand must be assignable to ` +
                            `(ref null eq), got ${operand.types.join(', ')}`);
                        return false;
                    }
                    return true;
                };
                const okA = check(refA, 'left');
                const okB = check(refB, 'right');
                if (!okA || !okB) resultTypes = null;
            }
            super(loc, resultTypes, [refA, refB], 'UNRESTRICTED');
            this.refA = refA;
            this.refB = refB;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([refA, refB]) {
            return new RefEq(this.loc, refA, refB);
        }
    }

    class RefCast extends Expression {
        // Cast `ref` to `targetRefType` (a RefType). Traps at runtime if the
        // cast fails. Result type is targetRefType.
        constructor(loc, ref, targetRefType) {
            const errors = [];
            let resultTypes = null;
            if (!(targetRefType instanceof T.RefType)) {
                errors.push('RefCast: targetRefType must be a RefType');
            } else if (ref.types === null) {
                // divergent
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('RefCast: source must be a single RefType value');
            } else {
                resultTypes = [targetRefType];
            }
            super(loc, resultTypes, [ref]);
            this.ref = ref;
            this.targetRefType = targetRefType;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            const h = this.targetRefType && this.targetRefType.heapType;
            if (h instanceof T.StructType || h instanceof T.ArrayType ||
                h instanceof T.FunctionType) {
                return new TreeBag(new Set([h]), inherited);
            }
            return inherited;
        }
        _withChildren([ref]) {
            return new RefCast(this.loc, ref, this.targetRefType);
        }
    }

    class RefTest extends Expression {
        constructor(loc, ref, targetRefType) {
            const errors = [];
            let resultTypes = [T.I32];
            if (!(targetRefType instanceof T.RefType)) {
                errors.push('RefTest: targetRefType must be a RefType');
                resultTypes = null;
            } else if (ref.types === null) {
                resultTypes = null;
            } else if (ref.types.length !== 1 || !(ref.types[0] instanceof T.RefType)) {
                errors.push('RefTest: source must be a single RefType value');
                resultTypes = null;
            }
            super(loc, resultTypes, [ref], 'UNRESTRICTED');
            this.ref = ref;
            this.targetRefType = targetRefType;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _computeReferencedTypes() {
            const inherited = super._computeReferencedTypes();
            const h = this.targetRefType && this.targetRefType.heapType;
            if (h instanceof T.StructType || h instanceof T.ArrayType ||
                h instanceof T.FunctionType) {
                return new TreeBag(new Set([h]), inherited);
            }
            return inherited;
        }
        _withChildren([ref]) {
            return new RefTest(this.loc, ref, this.targetRefType);
        }
    }

    // Return: divergent. Pops args off the stack as the function's return
    // value(s) and exits the enclosing function. We don't validate args
    // against the function's return type here (the function isn't visible
    // from the IR builder); the wasm validator catches mismatches.
    class Return extends Expression {
        constructor(loc, args) {
            super(loc, null, args);
            this.args = args;
            this._finalize();
        }
        _withChildren(newChildren) {
            return new Return(this.loc, newChildren);
        }
    }

    // Unreachable: divergent. Wasm `unreachable` opcode — traps at runtime if
    // reached. Useful for impossible branches and as a polymorphic-stack
    // satisfier in dead-code positions.
    class Unreachable extends Expression {
        constructor(loc) {
            super(loc, null, []);
            this._finalize();
        }
    }

    // Drop: discards every value the source expression produces. types = []
    // (it consumes whatever the source pushed and produces nothing). For a
    // multi-value source, codegen emits one `drop` per value.
    class Drop extends Expression {
        constructor(loc, source) {
            // Drop itself adds no observable effect — it's a stack-balancing
            // op. Linearity comes entirely from its child.
            super(loc, source.types === null ? null : [], [source], 'UNRESTRICTED');
            this.source = source;
            this._finalize();
        }
        _withChildren([source]) {
            return new Drop(this.loc, source);
        }
    }

    // Select: ternary. Pops `condition` (i32), `ifFalse`, `ifTrue` and pushes
    // ifTrue when condition != 0 else ifFalse. Both branches must have the
    // same single-value type.
    class Select extends Expression {
        constructor(loc, condition, ifTrue, ifFalse) {
            const errors = [];
            let resultTypes = null;
            let divergent = false;
            if (condition.types === null || ifTrue.types === null || ifFalse.types === null) {
                divergent = true;
            } else if (condition.types.length !== 1 || condition.types[0] !== T.I32) {
                errors.push(
                    `Select condition must be a single i32; ` +
                    `got (${condition.types.map(String).join(', ')})`);
                divergent = true;
            } else if (ifTrue.types.length !== 1 || ifFalse.types.length !== 1) {
                errors.push(`Select branches must each be single-value`);
                divergent = true;
            } else if (ifTrue.types[0] !== ifFalse.types[0]) {
                errors.push(
                    `Select branch types must agree; got ${ifTrue.types[0]} vs ${ifFalse.types[0]}`);
                divergent = true;
            } else {
                resultTypes = [ifTrue.types[0]];
            }
            // Select itself adds no observable effect — but unlike a wasm
            // `if` it eagerly evaluates both branches before the condition
            // picks one. So children's linearity bubbles up unchanged.
            super(loc, divergent ? null : resultTypes,
                  [condition, ifTrue, ifFalse], 'UNRESTRICTED');
            this.condition = condition;
            this.ifTrue = ifTrue;
            this.ifFalse = ifFalse;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([condition, ifTrue, ifFalse]) {
            return new Select(this.loc, condition, ifTrue, ifFalse);
        }
    }

    class Continue extends Expression {
        constructor(loc, label) {
            // types = null marks this expression as divergent: control never
            // falls off it, so it produces no observable values. Used by
            // Block/IfElse inference and by codegen body-emit (no drops).
            super(loc, null, []);
            this.label = label;
            this._finalize();
        }

        _computeContinueMap() {
            const out = super._computeContinueMap();
            const existing = out.get(this.label);
            out.set(this.label, existing
                ? new TreeBag(new Set([this]), existing)
                : new TreeBag(new Set([this])));
            return out;
        }
    }

    class Break extends Expression {
        constructor(loc, label, args) {
            super(loc, null, args); // divergent — see Continue
            this.label = label;
            this.args = args; // Array of Expression
            this._finalize();
        }

        _withChildren(newChildren) {
            return new Break(this.loc, this.label, newChildren);
        }

        _computeBreakMap() {
            const out = super._computeBreakMap();
            const existing = out.get(this.label);
            out.set(this.label, existing
                ? new TreeBag(new Set([this]), existing)
                : new TreeBag(new Set([this])));
            return out;
        }

        // Expose the multi-value payload type. Returns null if any arg is
        // itself divergent (we can't infer in that case).
        get argsTypes() {
            if (this.args.some(a => a.types === null)) return null;
            return this.args.flatMap(a => a.types);
        }
    }

    // BrIf: conditional branch. Emits `cond_bytes; arg_bytes; 0x0D <depth>`.
    // Unlike Break/Continue, BrIf falls through if the condition is false —
    // so it's NOT divergent, and `types` = [] (no result on fall-through).
    // Like Break, BrIf seeds itself into `breakMap` for the label so the
    // target Block sees the args as a contributor to its result types.
    class BrIf extends Expression {
        constructor(loc, label, condition, args) {
            const errors = [];
            if (condition.types !== null) {
                if (condition.types.length !== 1 ||
                    (condition.types[0].slotType || condition.types[0]) !== T.I32) {
                    errors.push('BrIf: condition must be a single i32');
                }
            }
            // Children: args first, then condition (matches wasm order).
            super(loc, errors.length > 0 ? null : [], [...args, condition]);
            this.label = label;
            this.condition = condition;
            this.args = args;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }

        _withChildren(newChildren) {
            const args = newChildren.slice(0, this.args.length);
            const condition = newChildren[this.args.length];
            return new BrIf(this.loc, this.label, condition, args);
        }

        _computeBreakMap() {
            const out = super._computeBreakMap();
            const existing = out.get(this.label);
            out.set(this.label, existing
                ? new TreeBag(new Set([this]), existing)
                : new TreeBag(new Set([this])));
            return out;
        }

        get argsTypes() {
            if (this.args.some(a => a.types === null)) return null;
            return this.args.flatMap(a => a.types);
        }
    }

    // Throw: divergent. Pops args matching tag.type.params, then throws.
    class Throw extends Expression {
        constructor(loc, tag, args) {
            const errors = [];
            if (!(tag instanceof Tag)) {
                errors.push('Throw: tag must be an IR.Tag');
            } else if (args.some(a => a.types === null)) {
                // already divergent — no further check
            } else {
                const argTypes = args.flatMap(a => a.types);
                const expected = tag.type.params;
                if (argTypes.length !== expected.length) {
                    errors.push(
                        `Throw: argument count mismatch ` +
                        `(expected ${expected.length}, got ${argTypes.length})`);
                } else {
                    for (let i = 0; i < argTypes.length; i++) {
                        if (!argTypes[i].isAssignableTo(expected[i])) {
                            errors.push(
                                `Throw: arg ${i} type mismatch ` +
                                `(expected ${expected[i]}, got ${argTypes[i]})`);
                        }
                    }
                }
            }
            super(loc, null, args);
            this.tag = tag;
            this.args = args;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren(newChildren) {
            return new Throw(this.loc, this.tag, newChildren);
        }
    }

    // ThrowRef: divergent. Pops an exnref and rethrows it via wasm's
    // `throw_ref` (0x0A). Used by lowerTryFinally to rethrow exceptions
    // captured by a catch_all_ref handler after running the finally body.
    class ThrowRef extends Expression {
        constructor(loc, exn) {
            const errors = [];
            if (exn.types !== null) {
                if (exn.types.length !== 1
                    || (exn.types[0].slotType || exn.types[0]) !== T.EXNREF) {
                    errors.push(
                        `ThrowRef: operand must be a single exnref; ` +
                        `got (${exn.types.map(String).join(', ')})`);
                }
            }
            super(loc, null, [exn]);
            this.exn = exn;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }
        _withChildren([exn]) {
            return new ThrowRef(this.loc, exn);
        }
    }

    // Synthetic break-stub seeded by TryTable's catches. Looks like a Break
    // (has `argsTypes`, `loc`, `label`) so that the enclosing Block's
    // type-inference / break-args validation treats catches uniformly with
    // explicit Break / BrTable.
    class _CatchBreakStub {
        constructor(loc, label, argsTypes) {
            this.loc = loc;
            this.label = label;
            this.argsTypes = argsTypes;
            Object.freeze(this);
        }
    }

    // TryTable: a structured try block. Body executes; if an exception
    // matches a catch handler, control jumps to that catch's targetLabel
    // carrying the appropriate payload.
    //
    // catches: Array<{ kind, tag?, label }>:
    //   - { kind: 'catch', tag, label }: catches `tag`, brings tag.params
    //     to the targetLabel's block.
    //   - { kind: 'catch_ref', tag, label }: catches `tag`, brings
    //     tag.params followed by an exnref.
    //   - { kind: 'catch_all', label }: catches anything, brings nothing.
    //   - { kind: 'catch_all_ref', label }: catches anything, brings an
    //     exnref.
    //
    // resultTypes is inferred just like Block: from breaks targeting our
    // own label, otherwise the body's fall-through. catches do NOT affect
    // our own result type — they target outer blocks.
    class TryTable extends Expression {
        constructor(loc, label, body, catches) {
            super(loc, [], body, 'UNRESTRICTED');
            this.label = label;
            this.body = body;
            this.catches = catches;

            // Compute own breaks (breaks targeting our own label) — we
            // consume our own label in _computeBreakMap.
            this.ownBreaks = Block._collectOwnLabel(body, label, c => c.breakMap);
            this.hasBreak = this.ownBreaks.size > 0;

            const { agreed: breakTypes, conflicts } = inferBreakTypes(this.ownBreaks);
            let resultTypes, divergent;
            if (conflicts > 0) {
                resultTypes = [];
                divergent = true;
            } else if (breakTypes !== null) {
                resultTypes = breakTypes;
                divergent = false;
            } else if (body.length === 0) {
                resultTypes = [];
                divergent = false;
            } else {
                const last = body[body.length - 1];
                if (last.types === null) {
                    resultTypes = [];
                    divergent = true;
                } else {
                    resultTypes = last.types;
                    divergent = false;
                }
            }
            this.resultTypes = resultTypes;
            this.types = divergent ? null : resultTypes;
            this._finalize();
        }

        _computeBreakMap() {
            // Strip our own label (consumed) and seed catches into the map
            // so outer blocks see them as contributors.
            const out = super._computeBreakMap();
            out.delete(this.label);
            for (const c of this.catches) {
                let payload;
                if (c.kind === 'catch_all') payload = [];
                else if (c.kind === 'catch_all_ref') payload = [T.EXNREF];
                else if (c.kind === 'catch') payload = c.tag.type.params;
                else if (c.kind === 'catch_ref') payload = [...c.tag.type.params, T.EXNREF];
                else throw new Error(`TryTable: unknown catch kind '${c.kind}'`);
                const stub = new _CatchBreakStub(this.loc, c.label, payload);
                const existing = out.get(c.label);
                out.set(c.label, existing
                    ? new TreeBag(new Set([stub]), existing)
                    : new TreeBag(new Set([stub])));
            }
            return out;
        }

        _computeCompoundTypes() {
            const inherited = super._computeCompoundTypes();
            if (this.resultTypes.length >= 2) {
                return new TreeBag(
                    new Set([T.functionTypeOf([], this.resultTypes)]),
                    inherited,
                );
            }
            return inherited;
        }
        _withChildren(newChildren) {
            return new TryTable(this.loc, this.label, newChildren, this.catches);
        }
    }

    // BrTable: divergent multi-target branch. Pops args + an i32 index,
    // branches to labels[index] (or defaultLabel if out of range) carrying
    // the args. All target labels must point at blocks expecting the same
    // result types as `args` produces — this is checked at the wasm
    // validator level (we don't validate cross-label-arity here since
    // labels are resolved lazily from the codegen labelStack).
    //
    // Like Break, BrTable seeds itself into `breakMap` for every label it
    // names so each target Block sees it as a contributor and runs its
    // arg-type validation against the same `args.flatMap(.types)`.
    class BrTable extends Expression {
        constructor(loc, indexExpr, labels, defaultLabel, args) {
            const errors = [];
            if (indexExpr.types !== null) {
                if (indexExpr.types.length !== 1 ||
                    (indexExpr.types[0].slotType || indexExpr.types[0]) !== T.I32) {
                    errors.push('BrTable: index must be a single i32');
                }
            }
            // br_table is unconditional control flow — types is always null.
            super(loc, null, [...args, indexExpr]);
            this.indexExpr = indexExpr;
            this.labels = labels;
            this.defaultLabel = defaultLabel;
            this.args = args;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }

        _computeBreakMap() {
            const out = super._computeBreakMap();
            const allLabels = new Set([...this.labels, this.defaultLabel]);
            for (const label of allLabels) {
                const existing = out.get(label);
                out.set(label, existing
                    ? new TreeBag(new Set([this]), existing)
                    : new TreeBag(new Set([this])));
            }
            return out;
        }

        _withChildren(newChildren) {
            const args = newChildren.slice(0, this.args.length);
            const indexExpr = newChildren[this.args.length];
            return new BrTable(this.loc, indexExpr, this.labels, this.defaultLabel, args);
        }

        // Same shape as Break — see comment there.
        get argsTypes() {
            if (this.args.some(a => a.types === null)) return null;
            return this.args.flatMap(a => a.types);
        }
    }

    // MultiValue: explicitly composes a multi-value tuple by stacking the
    // children's values in order. Its `types` is the concat of the children's
    // types. Useful inside Block bodies (whose default semantics drop all but
    // the last element's value) when you actually want the multi-value stack.
    class MultiValue extends Expression {
        constructor(loc, exprs) {
            // Pure sequencing — no own effect. Children determine linearity.
            super(loc, exprs.flatMap(e => e.types), exprs, 'UNRESTRICTED');
            this.exprs = exprs;
            this._finalize();
        }
        _withChildren(newChildren) {
            return new MultiValue(this.loc, newChildren);
        }
    }

    function typesEqual(a, b) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                const aSlot = a[i].slotType || a[i];
                const bSlot = b[i].slotType || b[i];
                if (aSlot !== bSlot) return false;
            }
        }
        return true;
    }

    function inferBreakTypes(ownBreaks) {
        // Returns { agreed, conflicts }:
        //   agreed:    the multi-value type all (non-divergent) breaks share,
        //              or null if there are no contributing breaks.
        //   conflicts: count of disagreements (each is also reported). Block
        //              uses this to decide whether to mark itself divergent
        //              and stop the error from cascading.
        // A break whose arg list is itself divergent contributes nothing.
        // Each entry must expose `argsTypes` (Break/BrTable do, and the
        // synthetic stubs that TryTable's catches seed do too).
        let agreed = null;
        let conflicts = 0;
        for (const brk of ownBreaks) {
            const types = brk.argsTypes;
            if (types === null) continue;
            if (agreed === null) {
                agreed = types;
            } else if (!typesEqual(agreed, types)) {
                reportError(brk.loc,
                    `Break to '${brk.label || ''}': arg types disagree with another break ` +
                    `to the same label: (${types.join(', ')}) vs (${agreed.join(', ')})`);
                conflicts++;
            }
        }
        return { agreed, conflicts };
    }

    function fallthroughTypes(body) {
        // Statement semantics: only the last expression contributes a value.
        // A trailing divergent expression (types === null) means fall-through
        // never actually happens — return [] (no value reaches the parent).
        if (body.length === 0) return [];
        const last = body[body.length - 1];
        if (last.types === null) return [];
        return last.types;
    }

    // A labeled block, an extension of wasm's `block` that may also be the
    // target of `continue` (which compiles to a `loop`). The body is a
    // sequence of expressions; their stack effects accumulate as in wasm.
    //
    // Codegen forms (see CODEGEN.emit):
    //   - no continue: `block <T> body end`
    //   - has continue: `block <T> loop body br 0 end unreachable end`
    //     (the inner loop is the continue target; the outer block is the
    //     break target. The synthetic `br 0` makes fall-off implicitly
    //     continue; `unreachable` keeps the validator happy.)
    // Block: a labeled sequence of expressions with statement semantics — only
    // the last expression contributes a value (intermediate values are dropped
    // by codegen). Wrap a body element in `MultiValue([...])` if you want
    // explicit multi-value stacking.
    //
    // resultTypes is INFERRED:
    //   - if any break targets this label, all breaks must agree on their
    //     arg types and that's the result;
    //   - otherwise the result is the last body element's `.types`
    //     (or `[]` for an empty body or a trailing Break/Continue).
    class Block extends Expression {
        constructor(loc, label, body) {
            // Pure sequencing — body's linearity bubbles up.
            super(loc, [], body, 'UNRESTRICTED'); // types set after inference
            this.label = label;
            this.body = body; // alias for children, kept for API clarity

            // Collect own breaks/continues by querying children's maps (which
            // still contain this label — only our own _computeBreakMap /
            // _computeContinueMap below strip it).
            this.ownBreaks = Block._collectOwnLabel(body, label, c => c.breakMap);
            this.ownContinues = Block._collectOwnLabel(body, label, c => c.continueMap);
            this.hasBreak = this.ownBreaks.size > 0;
            this.hasContinue = this.ownContinues.size > 0;

            // Inference: breaks win when present (and must agree); otherwise
            // body fall-through. If body's last expression is divergent
            // (types === null) and there are no breaks reaching us, the
            // Block itself diverges — IR-visible `types` is null; the wasm
            // block-type (`resultTypes`) defaults to [] (it's never used in
            // the "neither" codegen path anyway). Conflicting breaks also
            // mark us divergent so the error doesn't cascade to the parent.
            const { agreed: breakTypes, conflicts } = inferBreakTypes(this.ownBreaks);
            let resultTypes, divergent;
            if (conflicts > 0) {
                resultTypes = [];
                divergent = true;
            } else if (breakTypes !== null) {
                resultTypes = breakTypes;
                divergent = false;
            } else if (body.length === 0) {
                resultTypes = [];
                divergent = false;
            } else {
                const last = body[body.length - 1];
                if (last.types === null) {
                    resultTypes = [];
                    divergent = true;
                } else {
                    resultTypes = last.types;
                    divergent = false;
                }
            }
            this.resultTypes = resultTypes;
            this.types = divergent ? null : resultTypes;
            this._finalize();
        }

        _computeBreakMap() {
            // Strip our own label so outer scopes don't see breaks targeting us.
            const out = super._computeBreakMap();
            out.delete(this.label);
            return out;
        }

        _computeContinueMap() {
            const out = super._computeContinueMap();
            out.delete(this.label);
            return out;
        }

        _computeCompoundTypes() {
            const inherited = super._computeCompoundTypes();
            if (this.resultTypes.length >= 2) {
                // Multi-value block types must be encoded as a typeidx into
                // the wasm type section, so register the function type now.
                return new TreeBag(
                    new Set([T.functionTypeOf([], this.resultTypes)]),
                    inherited,
                );
            }
            return inherited;
        }

        // Block is a scope: it claims any descendant unclaimedSlots and
        // packages them with descendant FrameNodes into a fresh FrameNode
        // representing this scope. Re-published bags: unclaimedSlots empty
        // (claimed), frameNodes singleton {self}.
        _computeUnclaimedSlots() {
            return _EMPTY_TREE_BAG;
        }
        _computeFrameNodes() {
            const childUnclaimed = new TreeBag(null,
                ...this.children.map(c => c.unclaimedSlots));
            const childFrames = new TreeBag(null,
                ...this.children.map(c => c.frameNodes));
            // Dedup slots: the same StackSlot may appear once per
            // StackSlotAddr referencing it; we want each slot listed
            // exactly once for layout.
            const seen = new Set();
            const ownSlots = [];
            for (const s of childUnclaimed) {
                if (seen.has(s)) continue;
                seen.add(s);
                ownSlots.push(s);
            }
            const subFrames = [...childFrames];
            if (ownSlots.length === 0 && subFrames.length === 0) {
                return _EMPTY_TREE_BAG;
            }
            const fn = new FrameNode(this, ownSlots, subFrames);
            return new TreeBag(new Set([fn]));
        }

        static _collectOwnLabel(children, label, getMap) {
            let merged = null;
            for (const child of children) {
                const set = getMap(child).get(label);
                if (!set) continue;
                merged = merged ? new TreeBag(null, merged, set) : set;
            }
            return merged || _EMPTY_TREE_BAG;
        }

        _withChildren(newChildren) {
            return new Block(this.loc, this.label, newChildren);
        }
    }

    // IfElse: an unlabeled `if [<type>] then else end`. Wasm DOES allow `br`
    // to an if-block, but we don't expose that — wrap in `Block(...)` if you
    // want a break-out target.
    //
    // resultTypes is INFERRED from then/else fall-through: both must agree
    // when both branches actually fall through (a trailing Break/Continue is
    // divergent and contributes nothing). If only one branch falls through,
    // its types are the result; if neither does, the result is `[]`.
    //
    // Codegen always emits both `else` and `end`; an empty `elseBody` is
    // allowed only when resultTypes is empty.
    class IfElse extends Expression {
        constructor(loc, condition, thenBody, elseBody) {
            super(loc, [], [condition, ...thenBody, ...elseBody], 'UNRESTRICTED');
            this.condition = condition;
            this.thenBody = thenBody;
            this.elseBody = elseBody;

            const errors = [];
            let resultTypes = [];
            let divergent = false;

            // Validate the condition (a divergent condition just propagates).
            if (condition.types === null) {
                divergent = true;
            } else if (condition.types.length !== 1 || condition.types[0] !== T.I32) {
                errors.push(
                    `IfElse condition must produce a single i32; ` +
                    `got (${condition.types.map(String).join(', ')})`);
                divergent = true;
            }

            if (!divergent) {
                const thenLast = thenBody.length > 0 ? thenBody[thenBody.length - 1] : null;
                const elseLast = elseBody.length > 0 ? elseBody[elseBody.length - 1] : null;
                const thenTypes = (thenLast && thenLast.types === null)
                    ? null : (thenLast ? thenLast.types : []);
                const elseTypes = (elseLast && elseLast.types === null)
                    ? null : (elseLast ? elseLast.types : []);
                if (thenTypes !== null && elseTypes !== null) {
                    if (typesEqual(thenTypes, elseTypes)) {
                        resultTypes = thenTypes;
                    } else {
                        errors.push(
                            `IfElse branch types disagree: ` +
                            `then=(${thenTypes.join(', ')}) vs else=(${elseTypes.join(', ')})`);
                        divergent = true;
                    }
                } else if (thenTypes !== null) {
                    resultTypes = thenTypes;
                } else if (elseTypes !== null) {
                    resultTypes = elseTypes;
                } else {
                    // Both branches diverge — IfElse never produces a value.
                    divergent = true;
                }
            }

            this.resultTypes = resultTypes;
            this.types = divergent ? null : resultTypes;
            for (const msg of errors) reportError(loc, msg);
            this._finalize();
        }

        _computeCompoundTypes() {
            const inherited = super._computeCompoundTypes();
            if (this.resultTypes.length >= 2) {
                return new TreeBag(
                    new Set([T.functionTypeOf([], this.resultTypes)]),
                    inherited,
                );
            }
            return inherited;
        }
        _withChildren(newChildren) {
            // Preserve sub-array identity: if a branch's children all
            // round-tripped unchanged, reuse the original array so callers
            // can still detect "this branch wasn't touched" via `===`.
            const condition = newChildren[0];
            const thenLen = this.thenBody.length;
            const thenStart = 1, elseStart = 1 + thenLen;
            let thenChanged = false;
            for (let i = 0; i < thenLen; i++) {
                if (newChildren[thenStart + i] !== this.thenBody[i]) {
                    thenChanged = true; break;
                }
            }
            let elseChanged = false;
            for (let i = 0; i < this.elseBody.length; i++) {
                if (newChildren[elseStart + i] !== this.elseBody[i]) {
                    elseChanged = true; break;
                }
            }
            const thenBody = thenChanged
                ? newChildren.slice(thenStart, elseStart) : this.thenBody;
            const elseBody = elseChanged
                ? newChildren.slice(elseStart) : this.elseBody;
            return new IfElse(this.loc, condition, thenBody, elseBody);
        }
    }

    // TryFinally: a structured try/finally. The `body` Expression executes;
    // the `finallyBody` Expression then runs on EVERY exit path (normal
    // fall-through, return, outer-target break/continue, exception).
    //
    // TryFinally is a high-level construct that does NOT lower to a single
    // wasm instruction — it has no encoding. The `lowerTryFinally` IR pass
    // must run before codegen and desugars each TryFinally into a tower of
    // Block+TryTable(catch_all_ref) + cloned finally bodies. Codegen will
    // throw if it encounters a TryFinally that wasn't lowered.
    //
    // Result types: match `body.types` — the body's value flows through
    // (the finally runs as a void side-effect on the normal path, threaded
    // via MultiValue at lower time). If body diverges, TryFinally is
    // divergent.
    class TryFinally extends Expression {
        constructor(loc, body, finallyBody) {
            super(loc, body.types, [body, finallyBody], 'UNRESTRICTED');
            this.body = body;
            this.finallyBody = finallyBody;
            this._finalize();
        }
        _withChildren([body, finallyBody]) {
            return new TryFinally(this.loc, body, finallyBody);
        }
    }

    // ===================================================================
    // walkIR: generic IR Expression rewriter with identity preservation.
    //
    // Calls `fn(node)` on each Expression in pre-order. If `fn` returns
    // an expression, that expression replaces `node` and walkIR does NOT
    // recurse into the replacement (the caller is responsible for re-
    // walking it if they want children rewritten too). If `fn` returns
    // `undefined`, walkIR recurses into the node's children and rebuilds
    // the node only if any child changed.
    //
    // Identity preservation: if no child of `node` changed and `fn`
    // returned undefined, walkIR returns the original `node` — untouched
    // subtrees never re-run `_finalize()`. A pass that changes only a
    // small subtree pays only for nodes on the path to the root.
    //
    // Top-level `Function` is also accepted: its `body` is walked and (if
    // changed) a new Function with the same metadata + new body is
    // returned.
    // ===================================================================
    function walkIR(node, fn) {
        if (node instanceof Function) {
            const newBody = walkIR(node.body, fn);
            if (newBody === node.body) return node;
            return new Function(node.loc, node.importSpec, node.exportSpec,
                node.name, node.type, [...node.params], [...node.locals], newBody);
        }

        const replaced = fn(node);
        if (replaced !== undefined) return replaced;

        // Leaves (no expression children) round-trip unchanged.
        if (node.children.length === 0) return node;

        let changed = false;
        const newKids = new Array(node.children.length);
        for (let i = 0; i < node.children.length; i++) {
            const w = walkIR(node.children[i], fn);
            if (w !== node.children[i]) changed = true;
            newKids[i] = w;
        }
        return changed ? node._withChildren(newKids) : node;
    }

    // ===================================================================
    // cloneIR: deep clone with fresh label Symbols.
    //
    // Used by lowerTryFinally to copy the finally body once per exit path.
    // Each cloned subtree gets its OWN fresh Symbols for any Block/TryTable
    // labels defined inside it; Break/Continue/BrIf/BrTable referencing
    // those internal labels are remapped to the fresh Symbols. Labels that
    // target somewhere OUTSIDE the cloned subtree (i.e. not in the local
    // labelMap) keep their original Symbol — they're meant to escape.
    //
    // Identity-preserving for subtrees with no internal labels: walkIR
    // returns the original node unchanged, which is safe because IR is
    // immutable and bubble-up bags dedupe by JS-object identity.
    // ===================================================================
    function cloneIR(root) {
        const labelMap = new Map();
        const remap = (sym) => labelMap.has(sym) ? labelMap.get(sym) : sym;

        function clone(n) {
            if (n instanceof Block) {
                const newLabel = Symbol(n.label.description || 'block');
                labelMap.set(n.label, newLabel);
                return new Block(n.loc, newLabel, n.body.map(clone));
            }
            if (n instanceof TryTable) {
                const newLabel = Symbol(n.label.description || 'try');
                labelMap.set(n.label, newLabel);
                const newBody = n.body.map(clone);
                const newCatches = n.catches.map(c => ({ ...c, label: remap(c.label) }));
                return new TryTable(n.loc, newLabel, newBody, newCatches);
            }
            if (n instanceof Break) {
                return new Break(n.loc, remap(n.label), n.args.map(clone));
            }
            if (n instanceof Continue) {
                return new Continue(n.loc, remap(n.label));
            }
            if (n instanceof BrIf) {
                return new BrIf(n.loc, remap(n.label), clone(n.condition), n.args.map(clone));
            }
            if (n instanceof BrTable) {
                return new BrTable(n.loc, clone(n.indexExpr),
                    n.labels.map(remap), remap(n.defaultLabel), n.args.map(clone));
            }
            // Generic: walkIR descends into children. We delegate to clone()
            // for control-flow nodes (so labelMap stays correct).
            return walkIR(n, child => {
                if (child === n) return undefined;
                if (child instanceof Block || child instanceof TryTable
                    || child instanceof Break || child instanceof Continue
                    || child instanceof BrIf || child instanceof BrTable) {
                    return clone(child);
                }
                return undefined;
            });
        }

        return clone(root);
    }

    // ===================================================================
    // lowerTryFinally: IR-pass that desugars every TryFinally into a tower
    // of Block + TryTable(catch_all_ref) + cloned finally bodies.
    //
    // For each TryFinally, the pass:
    //   1. Finds cross-boundary exits in `body` — Return, plus Break/BrIf/
    //      BrTable/Continue whose label is defined OUTSIDE body. (Internal
    //      labels are detected by walking body for Block/TryTable nodes.)
    //   2. Allocates a fresh redirect label per exit kind/target.
    //   3. Rewrites body: replaces each cross-boundary exit with a Break
    //      to its redirect label, carrying the same args.
    //   4. Wraps the rewritten body in a TryTable with a catch_all_ref to
    //      a synthetic exn-handler block that captures the exnref into a
    //      function-level local, runs the cloned finally, and ThrowRef's
    //      the captured exnref.
    //   5. Builds an outermost Block layered with one Block per redirect
    //      label. Each redirect block's "after" runs the cloned finally and
    //      then performs the original exit (Return/Break/Continue).
    //
    // For value-producing exits (Return with values, Break with args), the
    // value is threaded through MultiValue([handler, fin_clone]) so the
    // captured value flows through while finally runs as a void side-effect.
    //
    // The function gains one shared `_tf_exn` local of type EXNREF (used as
    // a temporary by all TryFinally rewrites in that function — exception
    // lifetimes don't overlap, see the design notes).
    // ===================================================================
    function lowerTryFinally(program) {
        // Quick scan: skip work if no function contains TryFinally.
        let any = false;
        for (const fn of program.functions) {
            if (!fn.body) continue;
            walkIR(fn.body, n => {
                if (n instanceof TryFinally) { any = true; }
                return undefined;
            });
            if (any) break;
        }
        if (!any) return program;

        let labelId = 0;
        const freshSym = (prefix) => Symbol(`${prefix}_${labelId++}`);

        function lowerFunction(fn) {
            if (!fn.body) return fn;
            let containsTF = false;
            walkIR(fn.body, n => {
                if (n instanceof TryFinally) containsTF = true;
                return undefined;
            });
            if (!containsTF) return fn;

            const newLocals = [...fn.locals];
            let exnLocal = null;
            const ensureExnLocal = () => {
                if (!exnLocal) {
                    exnLocal = new LocalVariable(fn.loc, true, '_tf_exn', T.EXNREF);
                    newLocals.push(exnLocal);
                }
                return exnLocal;
            };
            const returnTypes = fn.type.results;

            const newBody = lowerInBody(fn.body, returnTypes, ensureExnLocal);

            return new Function(fn.loc, fn.importSpec, fn.exportSpec, fn.name,
                fn.type, [...fn.params], newLocals, newBody);
        }

        function lowerInBody(node, returnTypes, ensureExnLocal) {
            return walkIR(node, n => {
                if (n instanceof TryFinally) {
                    // Lower nested TryFinally inside body / finallyBody first.
                    const body = lowerInBody(n.body, returnTypes, ensureExnLocal);
                    const fin = lowerInBody(n.finallyBody, returnTypes, ensureExnLocal);
                    return expand(n.loc, body, fin, returnTypes, ensureExnLocal);
                }
                return undefined;
            });
        }

        function expand(loc, body, fin, returnTypes, ensureExnLocal) {
            const bodyTypes = body.types; // null if divergent

            // Step 1: find labels DEFINED inside body (so we can ignore
            // breaks/continues that target them — they're not crossing the
            // try-finally boundary).
            const internalLabels = new Set();
            walkIR(body, n => {
                if (n instanceof Block || n instanceof TryTable) {
                    internalLabels.add(n.label);
                }
                return undefined;
            });

            // Step 2: collect cross-boundary exits, deduped by target label.
            let hasReturn = false;
            const breakInfo = new Map();    // origLabel -> argsTypes
            const continueLabels = new Set();
            walkIR(body, n => {
                if (n instanceof Return) {
                    hasReturn = true;
                } else if (n instanceof Break && !internalLabels.has(n.label)) {
                    if (!breakInfo.has(n.label)) breakInfo.set(n.label, n.argsTypes || []);
                } else if (n instanceof BrIf && !internalLabels.has(n.label)) {
                    if (!breakInfo.has(n.label)) breakInfo.set(n.label, n.argsTypes || []);
                } else if (n instanceof BrTable) {
                    const argsTypes = n.argsTypes || [];
                    for (const l of [...n.labels, n.defaultLabel]) {
                        if (!internalLabels.has(l) && !breakInfo.has(l)) {
                            breakInfo.set(l, argsTypes);
                        }
                    }
                } else if (n instanceof Continue && !internalLabels.has(n.label)) {
                    continueLabels.add(n.label);
                }
                return undefined;
            });

            // Step 3: allocate redirect labels.
            const breakRedirect = new Map();
            const continueRedirect = new Map();
            const returnExit = hasReturn
                ? { kind: 'return', origLabel: null,
                    newLabel: freshSym('tf_return'), breakTypes: returnTypes }
                : null;
            const breakExits = [...breakInfo].map(([origLabel, breakTypes]) => {
                const ep = { kind: 'break', origLabel,
                    newLabel: freshSym('tf_break'), breakTypes };
                breakRedirect.set(origLabel, ep.newLabel);
                return ep;
            });
            const continueExits = [...continueLabels].map(origLabel => {
                const ep = { kind: 'continue', origLabel,
                    newLabel: freshSym('tf_continue'), breakTypes: [] };
                continueRedirect.set(origLabel, ep.newLabel);
                return ep;
            });
            const exitPaths = [
                ...(returnExit ? [returnExit] : []),
                ...breakExits,
                ...continueExits,
            ];

            // Step 4: rewrite body — redirect cross-boundary exits.
            const rewrittenBody = exitPaths.length === 0 ? body : walkIR(body, n => {
                if (n instanceof Return && returnExit) {
                    return new Break(n.loc, returnExit.newLabel, n.args);
                }
                if (n instanceof Break && breakRedirect.has(n.label)) {
                    return new Break(n.loc, breakRedirect.get(n.label), n.args);
                }
                if (n instanceof BrIf && breakRedirect.has(n.label)) {
                    return new BrIf(n.loc, breakRedirect.get(n.label),
                        n.condition, n.args);
                }
                if (n instanceof BrTable) {
                    let changed = false;
                    const newLabels = n.labels.map(l => {
                        if (breakRedirect.has(l)) { changed = true; return breakRedirect.get(l); }
                        return l;
                    });
                    let newDefault = n.defaultLabel;
                    if (breakRedirect.has(n.defaultLabel)) {
                        changed = true;
                        newDefault = breakRedirect.get(n.defaultLabel);
                    }
                    if (!changed) return undefined;
                    return new BrTable(n.loc, n.indexExpr, newLabels, newDefault, n.args);
                }
                if (n instanceof Continue && continueRedirect.has(n.label)) {
                    return new Continue(n.loc, continueRedirect.get(n.label));
                }
                return undefined;
            });

            // Step 5: build the layered structure.
            const innerLabel = freshSym('tf_inner');
            const exnLabel = freshSym('tf_exn');
            const outerLabel = freshSym('tf_normal');
            const exnLocal = ensureExnLocal();

            // Innermost: try_table around rewrittenBody, with catch_all_ref → exnLabel.
            const tryTable = new TryTable(loc, innerLabel, [rewrittenBody], [
                { kind: 'catch_all_ref', label: exnLabel },
            ]);

            // exn_handler block: type [EXNREF] (from the catch_all_ref stub).
            // Body sequences try_table with the normal-path "fin clone + br outer".
            // If body diverges, normal path is dead and we pad with Unreachable
            // to keep the validator happy. If body produces values, we use
            // MultiValue([tryTable, fin_clone]) to thread the value through fin.
            let exnHandlerBody;
            if (bodyTypes === null) {
                exnHandlerBody = [tryTable, new Unreachable(loc)];
            } else if (bodyTypes.length === 0) {
                exnHandlerBody = [tryTable, cloneIR(fin), new Break(loc, outerLabel, [])];
            } else {
                const mv = new MultiValue(loc, [tryTable, cloneIR(fin)]);
                exnHandlerBody = [new Break(loc, outerLabel, [mv])];
            }
            const exnHandlerBlock = new Block(loc, exnLabel, exnHandlerBody);

            // After exn_handler falls through (i.e., catch fired): exnref on
            // stack. Capture into local, run fin, throw_ref the local.
            let stmts = [
                new SetVars(loc, [exnLocal], [exnHandlerBlock]),
                cloneIR(fin),
                new ThrowRef(loc, new GetVars(loc, [exnLocal])),
            ];

            // Step 6: wrap successively in exit-path blocks.
            for (const ep of exitPaths) {
                const handlerBlock = new Block(loc, ep.newLabel, stmts);
                if (ep.breakTypes.length > 0) {
                    const mv = new MultiValue(loc, [handlerBlock, cloneIR(fin)]);
                    if (ep.kind === 'return') {
                        stmts = [new Return(loc, [mv])];
                    } else { // 'break'
                        stmts = [new Break(loc, ep.origLabel, [mv])];
                    }
                } else {
                    const finClone = cloneIR(fin);
                    if (ep.kind === 'return') {
                        stmts = [handlerBlock, finClone, new Return(loc, [])];
                    } else if (ep.kind === 'break') {
                        stmts = [handlerBlock, finClone, new Break(loc, ep.origLabel, [])];
                    } else { // 'continue'
                        stmts = [handlerBlock, finClone, new Continue(loc, ep.origLabel)];
                    }
                }
            }

            // Outermost: Block(outerLabel, stmts). Its result type is bodyTypes
            // (inferred from the Break(outerLabel, [...]) inside exnHandlerBlock,
            // or [] if body diverges).
            return new Block(loc, outerLabel, stmts);
        }

        const newFunctions = program.functions.map(lowerFunction);
        return new Program(newFunctions, program.variables, program.memorySpec,
            program.tables, program.elements, program.tags, program.customSections,
            program.dataInit);
    }

    return {
        Program,
        ImportSpec,
        ExportSpec,
        Variable,
        GlobalVariable,
        LocalVariable,
        Function,
        Table,
        ElementSegment,
        Tag,
        Expression,
        Literal,
        StringLiteral,
        GetVars,
        SetVars,
        TeeVars,
        FunctionCall,
        CallIndirect,
        RefFunc,
        FuncIndex,
        BinOp,
        UnaryOp,
        Convert,
        Load,
        Store,
        MemorySize,
        MemoryGrow,
        MemoryCopy,
        MemoryFill,
        BytesLiteral,
        MutableBytesLiteral,
        StackSlot,
        StackSlotAddr,
        Alloca,
        HeapBase,
        FrameNode,
        StructNew,
        StructNewDefault,
        StructGet,
        StructSet,
        ArrayNew,
        ArrayNewDefault,
        ArrayNewFixed,
        ArrayGet,
        ArraySet,
        ArrayLen,
        ArrayCopy,
        ArrayFill,
        AnyConvertExtern,
        ExternConvertAny,
        RefNull,
        RefIsNull,
        RefAsNonNull,
        RefEq,
        RefCast,
        RefTest,
        Return,
        Unreachable,
        Drop,
        Select,
        Continue,
        Break,
        BrIf,
        BrTable,
        Throw,
        ThrowRef,
        TryTable,
        TryFinally,
        MultiValue,
        Block,
        IfElse,
        walkIR,
        cloneIR,
        lowerTryFinally,
    };
})();

// OPTIMIZER: a unified IR→IR pass that fuses constant folding, inlining, and
// tree-shaking into a single root-driven traversal.
//
// The driver does a depth-first visit starting from a configurable root set
// (exported funcs by default, optionally a single named entry, or every
// function). Each visited function:
//   1. Recursively visits its dependencies (called functions, RefFunc'd
//      functions, referenced globals, tables, tags) BEFORE transforming its
//      own body — so by the time we walk the body, every callee is already
//      in its final post-optimization form.
//   2. Post-order rewrites the body with a fused fn:
//        a) constant fold (BinOp/IfElse/RefIsNull on literals);
//        b) inline at each direct FunctionCall whose callee passes the
//           heuristic.
//   3. Caches the final body keyed by Function.
//
// Cycles (mutual recursion) are detected via an `inProgress` set: a callee
// requested while still in progress returns `null`, and the caller's
// inlining check skips it (correctly leaves the call as a real call).
//
// Tree-shaking falls out of the visit set: anything never DFS'd from the
// roots is unreachable and is filtered out of the resulting Program. Globals
// / tables / tags / element segments collapse the same way.
const OPTIMIZER = (() => {
    // Post-order rewriter. `fn` is called on each node AFTER its children
    // have been recursively rewritten. Returning `undefined` (or `null`)
    // means "no change at this level"; returning a new Expression replaces
    // the node. The replacement is NOT itself recursed into — fn is
    // expected to produce a node that's already fully folded for its own
    // shape.
    function rewrite(node, fn) {
        const folded = IR.walkIR(node, n =>
            n === node ? undefined : rewrite(n, fn));
        const out = fn(folded);
        return out === undefined || out === null ? folded : out;
    }

    // Strip redundant single-valued wrappers around a body expression so
    // simple-body / param-usage analysis sees the actual operation. Each
    // case is a structurally-transparent wrapper for our purposes:
    //   - Return([x])           — at the top of a function body, "return x"
    //                             is exactly "the body produces x" once
    //                             inlined into a context that takes the
    //                             value directly.
    //   - Block([x]) (no labels)— a label-free, single-element Block is
    //                             the same bytes as just x.
    //   - MultiValue([x])       — degenerate single-element multi-value.
    function unwrap(body) {
        for (;;) {
            if (body instanceof IR.Return && body.args.length === 1) {
                body = body.args[0]; continue;
            }
            if (body instanceof IR.Block
                && body.body.length === 1
                && !body.hasBreak && !body.hasContinue) {
                body = body.body[0]; continue;
            }
            if (body instanceof IR.MultiValue && body.exprs.length === 1) {
                body = body.exprs[0]; continue;
            }
            return body;
        }
    }

    // Whitelist of node types that may appear in a body we're willing to
    // inline. The list is conservative: pure ops + direct calls, excluding
    // anything with control flow that would need local materialization to
    // preserve semantics under substitution (Block with breaks, IfElse,
    // loops, try/catch, etc.).
    const SIMPLE_BODY_OPS = new Set([
        IR.Literal, IR.StringLiteral, IR.BytesLiteral,
        IR.GetVars, IR.MemorySize,
        IR.BinOp, IR.UnaryOp, IR.Convert, IR.Select, IR.MultiValue,
        IR.RefNull, IR.RefFunc, IR.RefIsNull, IR.RefAsNonNull,
        IR.RefEq, IR.RefCast, IR.RefTest,
        IR.StructGet, IR.StructNew, IR.StructNewDefault,
        IR.ArrayGet, IR.ArrayLen,
        IR.ArrayNew, IR.ArrayNewDefault, IR.ArrayNewFixed,
        IR.AnyConvertExtern, IR.ExternConvertAny,
        IR.FunctionCall,
    ]);

    function isSimpleBody(node) {
        if (!SIMPLE_BODY_OPS.has(node.constructor)) return false;
        for (const c of node.children) {
            if (!isSimpleBody(c)) return false;
        }
        return true;
    }

    // Walk the body counting GetVars references to each param and the
    // pre-order index at which each is first seen. Disqualifies inlining
    // (returns null) if any param is the target of SetVars/TeeVars in the
    // body — a self-mutating param can't be substituted away naively.
    function paramUsage(body, params) {
        const paramSet = new Set(params);
        const usage = new Map();
        for (const p of params) usage.set(p, { count: 0, firstSeen: Infinity });
        let idx = 0, safe = true;
        function walk(n) {
            if (!safe) return;
            if ((n instanceof IR.SetVars || n instanceof IR.TeeVars)
                && n.variables.some(v => paramSet.has(v))) {
                safe = false; return;
            }
            if (n instanceof IR.GetVars) {
                for (const v of n.variables) {
                    const u = usage.get(v);
                    if (u) {
                        u.count++;
                        if (idx < u.firstSeen) u.firstSeen = idx;
                    }
                }
            }
            idx++;
            for (const c of n.children) walk(c);
        }
        walk(body);
        return safe ? usage : null;
    }

    // Heuristic: should we inline `callee` at this call site with these
    // args? Conservative version — substitutes args directly into the
    // callee's body without introducing temp locals. Safe iff:
    //   - body is small (nodeCount ≤ inlineMaxNodes after unwrapping);
    //   - body uses only whitelisted ops;
    //   - no param is mutated in the body;
    //   - for each LINEAR arg (impure / trapping / has identity), the
    //     corresponding param is used exactly once, and the usages of
    //     LINEAR-arg params occur in the same left-to-right order as the
    //     args (preserving wasm's eval order);
    //   - UNRESTRICTED args (PURE: Literal/RefNull/etc and immutable
    //     GetVars) have no usage-pattern restriction.
    function shouldInline(callee, args, options) {
        if (!callee.body) return false;
        if (callee.params.length !== args.length) return false;
        const max = options.inlineMaxNodes != null ? options.inlineMaxNodes : 12;
        const stripped = unwrap(callee.body);
        if (stripped.nodeCount > max) return false;
        if (!isSimpleBody(stripped)) return false;
        const usage = paramUsage(stripped, callee.params);
        if (!usage) return false;
        let prevFirstSeen = -1;
        for (let i = 0; i < args.length; i++) {
            const u = usage.get(callee.params[i]);
            if (args[i].linearity === 'UNRESTRICTED') continue;
            if (u.count !== 1) return false;
            if (u.firstSeen < prevFirstSeen) return false;
            prevFirstSeen = u.firstSeen;
        }
        return true;
    }

    // Substitute each `GetVars(param[i])` reference in the unwrapped body
    // with the call site's `args[i]`. Multi-variable GetVars (a single
    // GetVars naming several variables) is a rare degenerate case — skip
    // those rather than carve out a special path.
    function inlineCall(callee, args) {
        const stripped = unwrap(callee.body);
        const paramIdx = new Map();
        callee.params.forEach((p, i) => paramIdx.set(p, i));
        return IR.walkIR(stripped, n => {
            if (n instanceof IR.GetVars
                && n.variables.length === 1
                && paramIdx.has(n.variables[0])) {
                return args[paramIdx.get(n.variables[0])];
            }
            return undefined;
        });
    }

    // Foldable integer binops. Result-bound checking happens in the caller;
    // here we just produce the mathematical value (or null if the op isn't
    // foldable in this context).
    function evalIntBinOp(op, lhs, rhs, operandType) {
        switch (op) {
            case 'add': return lhs + rhs;
            case 'sub': return lhs - rhs;
            case 'mul': return lhs * rhs;
            case 'and': return lhs & rhs;
            case 'or':  return lhs | rhs;
            case 'xor': return lhs ^ rhs;
            case 'eq':  return lhs === rhs ? 1n : 0n;
            case 'ne':  return lhs !== rhs ? 1n : 0n;
            case 'lt':  return lhs <  rhs ? 1n : 0n;
            case 'gt':  return lhs >  rhs ? 1n : 0n;
            case 'le':  return lhs <= rhs ? 1n : 0n;
            case 'ge':  return lhs >= rhs ? 1n : 0n;
            // div/rem are LINEAR (zero divisor traps) — never reach here.
            // shl/shr/rotl/rotr need shift-mod-bitwidth handling — skip
            // for now to keep this conservative.
            default: return null;
        }
    }

    function tryFold(node) {
        // BinOp(Lit, Lit) on integer types — fold when result fits.
        if (node instanceof IR.BinOp
            && node.lhs instanceof IR.Literal
            && node.rhs instanceof IR.Literal
            && typeof node.lhs.value === 'bigint'
            && typeof node.rhs.value === 'bigint'
            && node.types && node.types.length === 1) {
            const operandType = node.lhs.type;
            const v = evalIntBinOp(node.op, node.lhs.value, node.rhs.value, operandType);
            if (v !== null) {
                const resultType = node.types[0];
                if (v >= resultType.minValue() && v <= resultType.maxValue()) {
                    return new IR.Literal(node.loc, resultType, v);
                }
            }
        }
        // IfElse(Lit, then, else) → Block of the live branch. Wrapping in a
        // Block keeps the result-type contract intact (the live branch is a
        // sequence; Block is the natural sequence container) and the
        // OPTIMIZER's later passes / unwrap can collapse it further.
        if (node instanceof IR.IfElse
            && node.condition instanceof IR.Literal
            && typeof node.condition.value === 'bigint') {
            const branch = node.condition.value !== 0n
                ? node.thenBody : node.elseBody;
            return new IR.Block(node.loc, Symbol('folded_if'), branch);
        }
        // ref.is_null on a literal ref.null — always 1.
        if (node instanceof IR.RefIsNull && node.ref instanceof IR.RefNull) {
            return new IR.Literal(node.loc, T.I32, 1n);
        }
        // ref.eq(ref.null, ref.null) — always 1.
        if (node instanceof IR.RefEq
            && node.refA instanceof IR.RefNull
            && node.refB instanceof IR.RefNull) {
            return new IR.Literal(node.loc, T.I32, 1n);
        }
        return undefined;
    }

    function pickRoots(program, from) {
        if (from === 'all') return program.functions.filter(f => f.body);
        if (typeof from === 'object' && from && from.entry) {
            return program.functions.filter(f => f.name === from.entry);
        }
        // 'exports' (default)
        return program.functions.filter(f => f.exportSpec);
    }

    function optimize(program, options) {
        options = options || {};
        const doFold      = options.fold      !== false;
        const doInline    = options.inline    !== false;
        const doTreeShake = options.treeShake !== false;
        const from        = options.from || 'exports';

        const roots = pickRoots(program, from);

        // ─── Phase 1: process bodies (DFS, callees-before-callers). ───
        // Reachability is NOT computed here — it has to be computed on the
        // final bodies after inlining/folding may have removed call sites.
        const processedBody = new Map();    // Function -> final body or null
        const inProgress    = new Set();

        function processFunc(fn) {
            if (processedBody.has(fn)) return processedBody.get(fn);
            if (inProgress.has(fn)) return null;     // cycle-break
            if (!fn.body) {
                processedBody.set(fn, null);          // import: no body
                return null;
            }
            inProgress.add(fn);
            // DFS into anything this body references so callees are in
            // their final form when we decide whether to inline them.
            (function walk(n) {
                if (n instanceof IR.FunctionCall) processFunc(n.func);
                else if (n instanceof IR.CallIndirect) {
                    // Element-segment'd funcs on this table become
                    // candidates too (their bodies should be optimized in
                    // case they're reachable in the final program).
                    for (const seg of program.elements) {
                        if (seg.table === n.table) {
                            for (const f of seg.functions) processFunc(f);
                        }
                    }
                }
                for (const c of n.children) walk(c);
            })(fn.body);
            for (const f of fn.body.referencedFunctions) processFunc(f);

            let newBody = fn.body;
            if (doFold || doInline) {
                const transform = (n) => {
                    if (doFold) {
                        const folded = tryFold(n);
                        if (folded) return folded;
                    }
                    if (doInline && n instanceof IR.FunctionCall) {
                        const target = processedBody.get(n.func);
                        if (target && shouldInline(n.func, n.args, options)) {
                            // Re-rewrite the inlined body: substituting args
                            // can expose fresh fold opportunities (e.g. an
                            // arg literal flowing into a BinOp).
                            return rewrite(inlineCall(n.func, n.args), transform);
                        }
                    }
                    return undefined;
                };
                newBody = rewrite(fn.body, transform);
            }

            processedBody.set(fn, newBody);
            inProgress.delete(fn);
            return newBody;
        }

        for (const r of roots) processFunc(r);
        // Element segments on tables that are roots-or-exported also need
        // their funcs processed (they may be hit only via CallIndirect).
        for (const t of program.tables) if (t.exportSpec) {
            for (const seg of program.elements) {
                if (seg.table === t) for (const f of seg.functions) processFunc(f);
            }
        }
        // Globals' initializers can RefFunc / Get other globals.
        for (const g of program.variables) if (g.exportSpec && g.init) {
            for (const f of g.init.referencedFunctions) processFunc(f);
        }

        // ─── Phase 2: reachability on FINAL bodies. ───
        // After Phase 1 some calls may have been inlined away — so dead
        // callees that were only called from the inline site are now
        // genuinely unreferenced.
        const reachableFns     = new Set();
        const reachableGlobals = new Set();
        const reachableTags    = new Set();
        const reachableTables  = new Set();

        function markRefs(expr) {
            if (!expr) return;
            (function walk(n) {
                if (n instanceof IR.FunctionCall) markFn(n.func);
                else if (n instanceof IR.CallIndirect) markTable(n.table);
                else if (n instanceof IR.Throw) reachableTags.add(n.tag);
                else if (n instanceof IR.GetVars
                      || n instanceof IR.SetVars
                      || n instanceof IR.TeeVars) {
                    for (const v of n.variables) {
                        if (v instanceof IR.GlobalVariable) markGlobal(v);
                    }
                }
                for (const c of n.children) walk(c);
            })(expr);
            for (const f of expr.referencedFunctions) markFn(f);
        }
        function markFn(fn) {
            if (reachableFns.has(fn)) return;
            reachableFns.add(fn);
            const body = processedBody.has(fn) ? processedBody.get(fn) : fn.body;
            if (body) markRefs(body);
        }
        function markGlobal(g) {
            if (reachableGlobals.has(g)) return;
            reachableGlobals.add(g);
            if (g.init) markRefs(g.init);
        }
        function markTable(t) {
            if (reachableTables.has(t)) return;
            reachableTables.add(t);
            for (const seg of program.elements) {
                if (seg.table === t) for (const f of seg.functions) markFn(f);
            }
        }

        for (const r of roots)              markFn(r);
        for (const g of program.variables)  if (g.exportSpec) markGlobal(g);
        for (const t of program.tables)     if (t.exportSpec) markTable(t);
        for (const t of program.tags)       if (t.exportSpec) reachableTags.add(t);

        // ─── Phase 3: filter the program. ───
        const fnOk     = doTreeShake ? f => reachableFns.has(f)     : () => true;
        const globalOk = doTreeShake ? g => reachableGlobals.has(g) : () => true;
        const tableOk  = doTreeShake ? t => reachableTables.has(t)  : () => true;
        const tagOk    = doTreeShake ? t => reachableTags.has(t)    : () => true;

        // Functions that weren't visited at all (tree-shake off, or pulled
        // in by ref-bubbleup but never optimized): leave their bodies alone.
        const newFns = program.functions.filter(fnOk).map(f => {
            const body = processedBody.get(f);
            if (body === undefined || body === f.body) return f;
            return new IR.Function(f.loc, f.importSpec, f.exportSpec,
                f.name, f.type, [...f.params], [...f.locals], body);
        });

        const newElements = program.elements
            .filter(seg => tableOk(seg.table))
            .map(seg => {
                const filtered = seg.functions.filter(fnOk);
                if (filtered.length === seg.functions.length) return seg;
                return new IR.ElementSegment(seg.loc, seg.table, seg.offset, filtered);
            });

        return new IR.Program(
            newFns,
            program.variables.filter(globalOk),
            program.memorySpec,
            program.tables.filter(tableOk),
            newElements,
            program.tags.filter(tagOk),
            program.customSections,
            program.dataInit,
        );
    }

    return { optimize, rewrite, tryFold, shouldInline, inlineCall, unwrap };
})();

const CODEGEN = (() => {

    function encodeLEBU128(value) {
        value = BigInt(value);
        assert(value >= 0n, 'LEB128 unsigned value must be non-negative');
        const bytes = [];
        do {
            let byte = Number(value & 0x7Fn);
            value >>= 7n;
            if (value !== 0n) byte |= 0x80;
            bytes.push(byte);
        } while (value !== 0n);
        return bytes;
    }

    function encodeLEBS128(value) {
        value = BigInt(value);
        const bytes = [];
        // BigInt `>>` already sign-extends for negative values, so no manual fixup is needed.
        while (true) {
            let byte = Number(value & 0x7Fn);
            value >>= 7n;
            const signBit = byte & 0x40;
            if ((value === 0n && !signBit) || (value === -1n && signBit)) {
                bytes.push(byte);
                return bytes;
            }
            bytes.push(byte | 0x80);
        }
    }

    function encodeString(s) {
        const utf8 = [...new TextEncoder().encode(s)];
        return [...encodeLEBU128(utf8.length), ...utf8];
    }

    function encodeF32(value) {
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, value, true);
        return [...new Uint8Array(buf)];
    }

    function encodeF64(value) {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, value, true);
        return [...new Uint8Array(buf)];
    }

    // Always-canonical: after producing a packed integral value, re-canonicalize
    // it (sign-extend for signed, mask for unsigned) so that downstream consumers
    // can treat the value as already in range. No-op for non-packed types and
    // floats. Only emitted by BinOp/UnaryOp — Literal/GetVars/SetVars rely on
    // inputs already being canonical.
    function packedFixup(t) {
        if (!t || !(t instanceof T.IntegralType) || !t.isPacked()) return [];
        if (t.signed) {
            if (t.bits === 8) return [0xC0];  // i32.extend8_s
            if (t.bits === 16) return [0xC1]; // i32.extend16_s
        } else {
            const mask = (1n << BigInt(t.bits)) - 1n;
            return [0x41, ...encodeLEBS128(mask), 0x71]; // i32.const mask; i32.and
        }
        return [];
    }

    function emit(program, options) {
        // Optional optimization pass. Off by default to keep emit's
        // observable behavior unchanged for callers that don't opt in.
        // Pass `{ optimize: true }` for default settings, or
        // `{ optimize: { from: 'main', inlineMaxNodes: 20 } }` for tuning.
        if (options && options.optimize) {
            const optOpts = options.optimize === true ? {} : options.optimize;
            program = OPTIMIZER.optimize(program, optOpts);
        }
        // Run IR-level lowering passes first. lowerTryFinally is a no-op
        // (returns the same Program) when no function contains TryFinally.
        program = IR.lowerTryFinally(program);

        const out = [];

        // Magic number + version
        out.push(0x00, 0x61, 0x73, 0x6D);
        out.push(0x01, 0x00, 0x00, 0x00);

        const section = (id, contents) =>
            [id, ...encodeLEBU128(contents.length), ...contents];

        // Append `bytes` (an array of u8s) to `out`. Avoid `out.push(...bytes)`
        // spread for large arrays — JS limits the number of spread arguments
        // (~64k frames), which would overflow on real-world programs (DOOM
        // etc. produce 1MB+ code sections). Chunked push.apply avoids that.
        const appendBytes = (out, bytes) => {
            const CHUNK = 32768;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                out.push.apply(out, bytes.slice(i, i + CHUNK));
            }
        };

        // Sort: imports first, then defined entries (preserving relative order otherwise).
        const stableImportSort = (a, b) => {
            if (a.importSpec && !b.importSpec) return -1;
            if (!a.importSpec && b.importSpec) return 1;
            return 0;
        };

        const functions = [...program.functions].sort(stableImportSort);
        const importedFunctions = functions.filter(f => f.importSpec);
        const definedFunctions = functions.filter(f => !f.importSpec);
        const funcIndexMap = new Map();
        functions.forEach((f, i) => funcIndexMap.set(f, i));

        const variables = [...program.variables].sort(stableImportSort);
        const importedGlobals = variables.filter(v => v.importSpec);
        const definedGlobals = variables.filter(v => !v.importSpec);

        // Collect unique string-literal values across all defined function
        // bodies. Each becomes an imported externref global from module `'#'`,
        // resolved at instantiation by the JS Strings importedStringConstants
        // compile option.
        const stringValueSet = new Set();
        for (const func of definedFunctions) {
            if (!func.body) continue;
            for (const sl of func.body.stringLiterals) stringValueSet.add(sl.value);
        }
        const stringValues = [...stringValueSet];
        const stringIndexMap = new Map();
        stringValues.forEach((s, i) => {
            stringIndexMap.set(s, importedGlobals.length + i);
        });

        // Global index space: imported user globals, then imported string
        // globals, then defined globals.
        const globalIndexMap = new Map();
        importedGlobals.forEach((v, i) => globalIndexMap.set(v, i));
        definedGlobals.forEach((v, i) => {
            globalIndexMap.set(v, importedGlobals.length + stringValues.length + i);
        });

        // Tables — same import-first ordering as functions/globals.
        const tables = [...program.tables].sort(stableImportSort);
        const importedTables = tables.filter(t => t.importSpec);
        const definedTables = tables.filter(t => !t.importSpec);
        const tableIndexMap = new Map();
        tables.forEach((t, i) => tableIndexMap.set(t, i));

        // Auto-table for `IR.FuncIndex(f)` references. We collect every
        // function reachable via FuncIndex anywhere in any defined function
        // body, allocate a fresh slot per distinct function (starting at 1;
        // index 0 is reserved as the null function-pointer), and synthesize
        // a (FUNCREF) Table + active ElementSegment populating those slots.
        // The table is exported as `__indirect_function_table` to match
        // common C-toolchain ABIs. CallIndirect with `table === null`
        // dispatches through this auto-table.
        const funcIndexFuncs = (() => {
            const seen = new Set();
            const ordered = [];
            for (const func of definedFunctions) {
                if (!func.body) continue;
                for (const f of func.body.tableReferencedFunctions) {
                    if (seen.has(f)) continue;
                    seen.add(f);
                    ordered.push(f);
                }
            }
            return ordered;
        })();
        const funcTableIdxMap = new Map();
        let autoTable = null;
        let autoTableSegment = null;
        // Detect any CallIndirect with table === null — even with zero
        // FuncIndex references, a null-table CallIndirect requires an
        // auto-table to dispatch through (it'll still trap at runtime if
        // its index isn't backed by a real function, but the module needs
        // to validate).
        const anyNullTableCI = (() => {
            for (const func of definedFunctions) {
                if (!func.body) continue;
                if (func.body.hasNullTableCallIndirect) return true;
            }
            return false;
        })();
        if (funcIndexFuncs.length > 0 || anyNullTableCI) {
            funcIndexFuncs.forEach((f, i) => funcTableIdxMap.set(f, i + 1));
            autoTable = new IR.Table(null, null,
                new IR.ExportSpec('__indirect_function_table'),
                T.FUNCREF, funcIndexFuncs.length + 1, null);
            if (funcIndexFuncs.length > 0) {
                autoTableSegment = new IR.ElementSegment(null, autoTable, 1, funcIndexFuncs);
            }
            tables.push(autoTable);
            definedTables.push(autoTable);
            tableIndexMap.set(autoTable, tables.length - 1);
        }

        // Tags — same shape.
        const programTags = [...program.tags].sort(stableImportSort);
        const importedTags = programTags.filter(t => t.importSpec);
        const definedTags = programTags.filter(t => !t.importSpec);
        const tagIndexMap = new Map();
        programTags.forEach((t, i) => tagIndexMap.set(t, i));

        // Functions referenced by RefFunc need to be "declared" before the
        // wasm validator accepts ref.func. We auto-emit a declarative
        // element segment for any such function not already exported (which
        // counts as a declaration). Active element segments also count, so
        // we union those in too.
        const refdFuncs = new Set();
        for (const func of definedFunctions) {
            if (!func.body) continue;
            for (const f of func.body.referencedFunctions) refdFuncs.add(f);
        }
        const declaredViaActive = new Set();
        for (const seg of program.elements) {
            for (const f of seg.functions) declaredViaActive.add(f);
        }
        if (autoTableSegment) {
            for (const f of autoTableSegment.functions) declaredViaActive.add(f);
        }
        const declarativeFuncs = [];
        for (const f of refdFuncs) {
            if (f.exportSpec) continue; // exported is a declaration
            if (declaredViaActive.has(f)) continue;
            declarativeFuncs.push(f);
        }

        // Lay out BytesLiterals + MutableBytesLiterals in linear memory.
        // Immutable BytesLiterals are deduplicated by content (repeated
        // identical blobs share a single data segment); MutableBytesLiterals
        // each get a unique address (no dedup, since they're mutated at
        // runtime). All blobs sit in one contiguous static-data region
        // starting at `staticDataBase`.
        const memorySpec = program.memorySpec;
        const staticDataBase = (memorySpec && memorySpec.staticDataBase) || 0;
        const dataSegments = []; // [{ offset, bytes }]
        const bytesAddrMap = new Map(); // BytesLiteral|MutableBytesLiteral -> address
        let staticDataEnd = staticDataBase;
        if (memorySpec) {
            const byContentKey = new Map(); // content key -> address
            let cursor = staticDataBase;
            if (program.dataInit && program.dataInit.length > 0) {
                dataSegments.push({ offset: staticDataBase, bytes: program.dataInit });
                cursor += program.dataInit.length;
            }
            for (const func of definedFunctions) {
                if (!func.body) continue;
                for (const bl of func.body.bytesLiterals) {
                    if (bl instanceof IR.MutableBytesLiteral) {
                        // Each mutable literal gets its own address.
                        const addr = cursor;
                        dataSegments.push({ offset: addr, bytes: bl.bytes });
                        cursor += bl.bytes.length;
                        bytesAddrMap.set(bl, addr);
                        continue;
                    }
                    const key = Array.from(bl.bytes).join(',');
                    let addr = byContentKey.get(key);
                    if (addr === undefined) {
                        addr = cursor;
                        byContentKey.set(key, addr);
                        dataSegments.push({ offset: addr, bytes: bl.bytes });
                        cursor += bl.bytes.length;
                    }
                    bytesAddrMap.set(bl, addr);
                }
            }
            staticDataEnd = cursor;
        }

        // Stack region & __stack_pointer:
        //   - When memorySpec.stackPages is set, we reserve that many wasm
        //     pages immediately after the static-data region for the stack.
        //     SP is initialized to the *top* of the region (stack grows
        //     down toward staticDataEnd).
        //   - HeapBase is the first byte after the stack region.
        //   - When stackPages is absent or 0, no SP global is created and
        //     IR.HeapBase resolves to the first 16-byte-aligned address
        //     after staticDataEnd. Functions with StackSlots still get a
        //     prologue (with no SP save needed) — but in practice frontends
        //     should set stackPages whenever they use StackSlots.
        const PAGE = 65536;
        const stackPages = (memorySpec && memorySpec.stackPages) || 0;
        const minHeapPages = (memorySpec && memorySpec.minHeapPages) || 0;
        const align16 = (n) => (n + 15) & ~15;
        const stackStart = align16(staticDataEnd);
        const stackTop = stackStart + stackPages * PAGE;
        const heapBaseAddr = stackTop;
        // computedMinPages: smallest page count that fits everything.
        const computedMinPages = Math.max(
            1,
            Math.ceil((heapBaseAddr + minHeapPages * PAGE) / PAGE),
        );

        // Synthesize __stack_pointer if we have a stack.
        let stackPointerGlobal = null;
        let stackPointerIndex = -1;
        if (stackPages > 0) {
            stackPointerGlobal = new IR.GlobalVariable(
                null, null, new IR.ExportSpec('__stack_pointer'),
                true, '__stack_pointer', T.I32,
                new IR.Literal(null, T.I32, BigInt(stackTop)),
            );
            // Append to definedGlobals (after string globals, after user
            // defined globals). It needs an index in globalIndexMap, and
            // it must also live in `variables` so the exports loop picks
            // up its exportSpec.
            stackPointerIndex = importedGlobals.length + stringValues.length
                + definedGlobals.length;
            definedGlobals.push(stackPointerGlobal);
            variables.push(stackPointerGlobal);
            globalIndexMap.set(stackPointerGlobal, stackPointerIndex);
        }

        // Per-function frame layout. The function body's frameNodes +
        // unclaimedSlots are rolled into a synthetic root FrameNode and
        // laid out depth-first with sibling overlay (stack coloring).
        // Result: per StackSlot offset within the function frame, plus the
        // function's total frame size in bytes.
        //   slotOffsets: Map<StackSlot, number>
        //   frameSizeByFunc: Map<Function, number>
        const slotOffsets = new Map();
        const frameSizeByFunc = new Map();
        const layoutFrameNode = (node, baseOffset, color) => {
            // Lay out ownSlots packed by alignment, starting at baseOffset.
            let off = baseOffset;
            for (const slot of node.ownSlots) {
                off = (off + slot.align - 1) & ~(slot.align - 1);
                slotOffsets.set(slot, off);
                off += slot.size;
            }
            const ownEnd = off;
            // Children: overlay (max not sum) when `color` is true,
            // otherwise stack them sequentially. We always try to align
            // each child's start to 16 for safety.
            let childStart = (ownEnd + 15) & ~15;
            let maxEnd = ownEnd;
            for (const ch of node.children) {
                const chEnd = layoutFrameNode(ch, childStart, color);
                if (color) {
                    if (chEnd > maxEnd) maxEnd = chEnd;
                    // Next sibling overlays; keep childStart fixed.
                } else {
                    maxEnd = chEnd;
                    childStart = (chEnd + 15) & ~15;
                }
            }
            return maxEnd;
        };
        // Dedup slots from a TreeBag (where the same slot may appear once
        // per StackSlotAddr referencing it). Preserves first-encounter order.
        const dedupSlots = (bag) => {
            const seen = new Set();
            const out = [];
            for (const s of bag) {
                if (seen.has(s)) continue;
                seen.add(s);
                out.push(s);
            }
            return out;
        };
        for (const func of definedFunctions) {
            if (!func.body) { frameSizeByFunc.set(func, 0); continue; }
            const body = func.body;
            const topFrames = [...body.frameNodes];
            const topUnclaimed = dedupSlots(body.unclaimedSlots);
            if (topFrames.length === 0 && topUnclaimed.length === 0
                    && !body.containsAlloca) {
                frameSizeByFunc.set(func, 0);
                continue;
            }
            // Coloring is disabled if the function contains alloca anywhere.
            const color = !body.containsAlloca;
            const root = new IR.FrameNode(null, topUnclaimed, topFrames);
            const totalSize = layoutFrameNode(root, 0, color);
            // 16-byte align the frame total size.
            frameSizeByFunc.set(func, align16(totalSize));
        }

        // Type-section pipeline:
        //   1. Discover roots (function signatures + bubble-up types).
        //   2. Tarjan's SCC over the heap-type dependency graph.
        //   3. Build typeIndexMap by SCC topological order — types within an
        //      SCC sit consecutively; SCCs with deps come AFTER their deps,
        //      which is exactly what Tarjan's natural output gives us.
        //
        // The dep edges of a heap type are: ref-fields/elements that point
        // at a concrete heap type, the function-type's params/results that
        // do the same, and the StructType.parent supertype declaration.
        const getDirectDeps = (t) => {
            const deps = [];
            const fromValtype = (vt) => {
                if (vt instanceof T.RefType) {
                    const h = vt.heapType;
                    if (h instanceof T.StructType || h instanceof T.ArrayType ||
                        h instanceof T.FunctionType) {
                        deps.push(h);
                    }
                }
            };
            if (t instanceof T.StructType) {
                for (const f of t.fields) fromValtype(f.type);
                if (t.parent) deps.push(t.parent);
            } else if (t instanceof T.ArrayType) {
                fromValtype(t.elementType);
            } else if (t instanceof T.FunctionType) {
                for (const p of t.params) fromValtype(p);
                for (const r of t.results) fromValtype(r);
            }
            return deps;
        };

        // Tarjan's SCC. Outputs SCCs in reverse topological order of the
        // condensation — i.e. an SCC with no outgoing edges to other SCCs
        // comes out first, which is exactly the order we want for the wasm
        // type section (deps emitted before dependents).
        const tarjan = (roots, getEdges) => {
            const indices = new Map();
            const lowlinks = new Map();
            const onStack = new Set();
            const stack = [];
            const sccs = [];
            let nextIndex = 0;
            const strongconnect = (v) => {
                indices.set(v, nextIndex);
                lowlinks.set(v, nextIndex);
                nextIndex++;
                stack.push(v);
                onStack.add(v);
                for (const w of getEdges(v)) {
                    if (!indices.has(w)) {
                        strongconnect(w);
                        const lw = lowlinks.get(w);
                        if (lw < lowlinks.get(v)) lowlinks.set(v, lw);
                    } else if (onStack.has(w)) {
                        const iw = indices.get(w);
                        if (iw < lowlinks.get(v)) lowlinks.set(v, iw);
                    }
                }
                if (lowlinks.get(v) === indices.get(v)) {
                    const scc = [];
                    let w;
                    do {
                        w = stack.pop();
                        onStack.delete(w);
                        scc.push(w);
                    } while (w !== v);
                    sccs.push(scc);
                }
            };
            for (const v of roots) if (!indices.has(v)) strongconnect(v);
            return sccs;
        };

        // Discover the root set of types we want in the section.
        const typeRoots = [];
        const seenRoot = new Set();
        const addRoot = (t) => {
            if (!seenRoot.has(t)) { seenRoot.add(t); typeRoots.push(t); }
        };
        for (const func of functions) addRoot(func.type);
        for (const tag of programTags) addRoot(tag.type);
        for (const func of definedFunctions) {
            if (!func.body) continue;
            for (const ft of func.body.compoundTypes) addRoot(ft);
            for (const ht of func.body.referencedTypes) addRoot(ht);
        }

        // Compute SCCs; flatten into typeArray with consecutive SCC members.
        const sccs = tarjan(typeRoots, getDirectDeps);
        const typeArray = [];
        const typeIndexMap = new Map();
        const sccByType = new Map();
        for (const scc of sccs) {
            for (const t of scc) {
                sccByType.set(t, scc);
                typeIndexMap.set(t, typeArray.length);
                typeArray.push(t);
            }
        }

        // An SCC needs explicit `rec` wrapping when it has more than one
        // member, OR when its single member has a self-edge (e.g. a struct
        // with a field of (ref null Self)).
        const sccHasSelfReference = (scc) => {
            if (scc.length > 1) return true;
            const t = scc[0];
            for (const dep of getDirectDeps(t)) if (dep === t) return true;
            return false;
        };

        // Encode a wasm valtype into bytes. Always returns an Array so
        // callers can spread uniformly. Closes over typeIndexMap when ref
        // types reference concrete heap types.
        const encodeValtype = (t) => {
            const s = t.slotType || t;
            if (s === T.I32) return [0x7F];
            if (s === T.I64) return [0x7E];
            if (s === T.F32) return [0x7D];
            if (s === T.F64) return [0x7C];
            if (s === T.FUNCREF) return [0x70];
            if (s === T.EXTERNREF || s === T.REFEXTERN) return [0x6F];
            if (s === T.EXNREF) return [0x69];
            if (s instanceof T.RefType) {
                // Nullable refs to abstract heap types use the heap type's
                // single-byte shorthand. Everything else is the explicit
                // form: 0x63 (nullable) or 0x64 (non-null) + heap.
                if (s.nullable && s.heapType instanceof T.HeapType) {
                    return [s.heapType.byte];
                }
                return [s.nullable ? 0x63 : 0x64, ...encodeHeapType(s.heapType)];
            }
            throw new Error('Unsupported type: ' + t);
        };

        const encodeHeapType = (h) => {
            if (h instanceof T.HeapType) return [h.byte];
            const idx = typeIndexMap.get(h);
            assert(idx !== undefined,
                () => `Heap type ${h} not registered in type section`);
            return encodeLEBS128(idx);
        };

        // For struct/array storage types, fields can be packed (i8/i16) —
        // those use special storage-type bytes 0x78 (i8) and 0x77 (i16)
        // instead of the i32 valtype.
        const encodeStorageType = (field) => {
            if (field.packedKind === 'i8') return [0x78];
            if (field.packedKind === 'i16') return [0x77];
            return encodeValtype(field.type);
        };

        // Per-function context — set before encoding a function body, cleared after.
        let currentLocalIndexMap = null;
        // Restore-SP bytes prefixed to every emitted Return when the
        // current function owns a stack frame (or contains alloca). Empty
        // otherwise.
        let currentReturnRestoreBytes = [];
        // The function's _saved_sp local index (-1 if no frame). The
        // static frame top is at saved_sp; static slots are addressed as
        // saved_sp + (offset - frameSize), which is stable across allocas.
        let currentSavedSpIdx = -1;
        let currentFrameSize = 0;
        // Stack of {name, kind} entries, one per enclosing wasm scope.
        // 'block' scopes catch `break`s; 'loop' scopes catch `continue`s.
        const labelStack = [];

        const resolveLabel = (label, kind) => {
            for (let i = labelStack.length - 1; i >= 0; i--) {
                const e = labelStack[i];
                if (e.name === label && e.kind === kind) {
                    return labelStack.length - 1 - i;
                }
            }
            return -1;
        };

        // Statement-style body emission: each non-last expression has its
        // values dropped (one wasm `drop` per stack value), and the last
        // expression's value flows through. Used by Block / IfElse / TryTable
        // bodies. `expectedResultTypes` is the surrounding block's blocktype
        // — if the last body element is IR-divergent (types === null) but
        // the validator might not be in a stack-polymorphic state (e.g. the
        // last element was a nested block whose blocktype reset polymorphism),
        // we trail `unreachable` to satisfy the outer block's non-empty type.
        const emitStatementBody = (out, body, expectedResultTypes) => {
            for (let i = 0; i < body.length; i++) {
                out.push(...encodeExpression(body[i]));
                if (i < body.length - 1) {
                    const n = (body[i].types ?? []).length;
                    for (let v = 0; v < n; v++) out.push(0x1A);
                }
            }
            if (body.length > 0
                && body[body.length - 1].types === null
                && expectedResultTypes && expectedResultTypes.length > 0) {
                out.push(0x00); // unreachable
            }
        };

        const encodeBlockType = (types) => {
            if (types.length === 0) return [0x40];
            if (types.length === 1) return encodeValtype(types[0]);
            const ft = T.functionTypeOf([], types);
            const idx = typeIndexMap.get(ft);
            assert(idx !== undefined, 'Block multi-value type not pre-registered');
            return encodeLEBS128(idx);
        };

        const encodeVarGet = (v) => {
            if (v instanceof IR.LocalVariable) {
                assert(currentLocalIndexMap, 'Local reference outside a function body');
                const idx = currentLocalIndexMap.get(v);
                assert(idx !== undefined, () => `Local '${v.name}' not in current function`);
                return [0x20, ...encodeLEBU128(idx)]; // local.get
            }
            return [0x23, ...encodeLEBU128(globalIndexMap.get(v))]; // global.get
        };

        const encodeVarSet = (v) => {
            if (v instanceof IR.LocalVariable) {
                assert(currentLocalIndexMap, 'Local reference outside a function body');
                const idx = currentLocalIndexMap.get(v);
                assert(idx !== undefined, () => `Local '${v.name}' not in current function`);
                return [0x21, ...encodeLEBU128(idx)]; // local.set
            }
            return [0x24, ...encodeLEBU128(globalIndexMap.get(v))]; // global.set
        };

        const encodeExpression = (expr) => {
            if (expr instanceof IR.StringLiteral) {
                // Resolved at instantiation by importedStringConstants — we
                // just emit `global.get` of the import slot we set up above.
                const idx = stringIndexMap.get(expr.value);
                assert(idx !== undefined,
                    () => `String literal not registered: ${expr.value}`);
                return [0x23, ...encodeLEBU128(idx)];
            } else if (expr instanceof IR.Literal) {
                const slot = expr.type.slotType || expr.type;
                if (slot === T.I32) {
                    let v = expr.value;
                    // i32.const expects a signed 32-bit value. For unsigned
                    // 32-bit IR types whose value is in the upper half, wrap
                    // to the i32 signed view so the LEB128 is compact and
                    // wasm accepts it.
                    if (!expr.type.signed && v >= 0x80000000n) v -= 0x100000000n;
                    return [0x41, ...encodeLEBS128(v)];
                } else if (slot === T.I64) {
                    let v = expr.value;
                    if (!expr.type.signed && v >= 0x8000000000000000n) v -= 0x10000000000000000n;
                    return [0x42, ...encodeLEBS128(v)];
                } else if (slot === T.F32) {
                    return [0x43, ...encodeF32(expr.value)];
                } else if (slot === T.F64) {
                    return [0x44, ...encodeF64(expr.value)];
                } else {
                    throw new Error('Unsupported literal type: ' + expr.type);
                }
            } else if (expr instanceof IR.GetVars) {
                return expr.variables.flatMap(encodeVarGet);
            } else if (expr instanceof IR.SetVars) {
                const valueBytes = expr.values.flatMap(v => encodeExpression(v));
                // Stack top is the last value, which corresponds to the last
                // variable, so set in reverse order.
                const setBytes = [...expr.variables].reverse().flatMap(encodeVarSet);
                return [...valueBytes, ...setBytes];
            } else if (expr instanceof IR.TeeVars) {
                const valueBytes = encodeExpression(expr.value);
                // Single-local fast path: emit `local.tee idx` (0x22).
                if (expr.variables.length === 1 && expr.variables[0] instanceof IR.LocalVariable) {
                    const v = expr.variables[0];
                    assert(currentLocalIndexMap, 'Local reference outside a function body');
                    const idx = currentLocalIndexMap.get(v);
                    assert(idx !== undefined, () => `Local '${v.name}' not in current function`);
                    return [...valueBytes, 0x22, ...encodeLEBU128(idx)];
                }
                // Fallback: set in reverse, then get in order. Same as
                // SetVars+GetVars without the intermediate IR node.
                const setBytes = [...expr.variables].reverse().flatMap(encodeVarSet);
                const getBytes = expr.variables.flatMap(encodeVarGet);
                return [...valueBytes, ...setBytes, ...getBytes];
            } else if (expr instanceof IR.FunctionCall) {
                const funcIndex = funcIndexMap.get(expr.func);
                assert(funcIndex !== undefined, () => `Unknown function: ${expr.func.name}`);
                const argBytes = expr.args.flatMap(arg => encodeExpression(arg));
                return [...argBytes, 0x10, ...encodeLEBU128(funcIndex)];
            } else if (expr instanceof IR.CallIndirect) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                const idxBytes = encodeExpression(expr.indexExpr);
                if (expr.types === null) return [...argBytes, ...idxBytes];
                // table === null → dispatch through the auto-table
                // populated from IR.FuncIndex references.
                const tbl = expr.table === null ? autoTable : expr.table;
                assert(tbl !== null,
                    'CallIndirect: null table but no FuncIndex references; ' +
                    'auto-table not synthesized');
                return [
                    ...argBytes, ...idxBytes,
                    0x11,
                    ...encodeLEBU128(typeIndexMap.get(expr.funcType)),
                    ...encodeLEBU128(tableIndexMap.get(tbl)),
                ];
            } else if (expr instanceof IR.RefFunc) {
                return [0xD2, ...encodeLEBU128(funcIndexMap.get(expr.func))];
            } else if (expr instanceof IR.FuncIndex) {
                const idx = funcTableIdxMap.get(expr.func);
                assert(idx !== undefined, () =>
                    `FuncIndex: function ${expr.func.name} not registered ` +
                    `in auto-table (was tableReferencedFunctions empty?)`);
                return [0x41, ...encodeLEBS128(idx)]; // i32.const idx
            } else if (expr instanceof IR.BinOp) {
                const lhsBytes = encodeExpression(expr.lhs);
                const rhsBytes = encodeExpression(expr.rhs);
                if (expr.types === null) {
                    // Divergent — at least one operand diverges; the binop
                    // itself never executes. Emit operand bytes and stop;
                    // wasm's polymorphic-stack rule covers the rest.
                    return [...lhsBytes, ...rhsBytes];
                }
                const operandT = expr.lhs.types[0];
                const slotName = (operandT.slotType || operandT).name;
                const meta = OPS.BINOPS[expr.op];
                let opVariant = expr.op;
                if (meta.signed && operandT.isIntegralType()) {
                    opVariant += operandT.signed ? '_s' : '_u';
                }
                const opcode = meta.opcodes[`${slotName}.${opVariant}`];
                assert(opcode !== undefined,
                    () => `No wasm opcode for ${slotName}.${opVariant}`);
                return [
                    ...lhsBytes,
                    ...rhsBytes,
                    opcode,
                    ...packedFixup(expr.types[0]),
                ];
            } else if (expr instanceof IR.UnaryOp) {
                const operandBytes = encodeExpression(expr.operand);
                if (expr.types === null) return operandBytes;
                const operandT = expr.operand.types[0];
                const slotName = (operandT.slotType || operandT).name;
                const meta = OPS.UNARYOPS[expr.op];
                const opcode = meta.opcodes[`${slotName}.${expr.op}`];
                assert(opcode !== undefined,
                    () => `No wasm opcode for ${slotName}.${expr.op}`);
                return [
                    ...operandBytes,
                    opcode,
                    ...packedFixup(expr.types[0]),
                ];
            } else if (expr instanceof IR.Convert) {
                const sourceBytes = encodeExpression(expr.source);
                if (expr.types === null) return sourceBytes;
                const meta = OPS.CONVERSIONS[expr.op];
                return [...sourceBytes, meta.opcode];
                // No packedFixup: conversion results are always I32/I64/F32/
                // F64/U32/U64 (never narrower types like U8).
            } else if (expr instanceof IR.Load) {
                const addrBytes = encodeExpression(expr.addr);
                if (expr.types === null) return addrBytes;
                const meta = OPS.LOADS[expr.op];
                // Sub-i32 loads (load8_s/u, load16_s/u) already deliver a
                // canonical packed value: load8_s sign-extends, load*_u
                // zero-extends. So no packedFixup needed.
                return [
                    ...addrBytes,
                    meta.opcode,
                    ...encodeLEBU128(expr.align),
                    ...encodeLEBU128(expr.offset),
                ];
            } else if (expr instanceof IR.Store) {
                const addrBytes = encodeExpression(expr.addr);
                const valueBytes = encodeExpression(expr.value);
                if (expr.types === null) return [...addrBytes, ...valueBytes];
                const meta = OPS.STORES[expr.op];
                return [
                    ...addrBytes,
                    ...valueBytes,
                    meta.opcode,
                    ...encodeLEBU128(expr.align),
                    ...encodeLEBU128(expr.offset),
                ];
            } else if (expr instanceof IR.MemorySize) {
                return [0x3F, 0x00]; // memory.size, memidx 0
            } else if (expr instanceof IR.MemoryGrow) {
                const deltaBytes = encodeExpression(expr.delta);
                if (expr.types === null) return deltaBytes;
                return [...deltaBytes, 0x40, 0x00]; // memory.grow, memidx 0
            } else if (expr instanceof IR.MemoryCopy) {
                const dstBytes = encodeExpression(expr.dst);
                const srcBytes = encodeExpression(expr.src);
                const nBytes = encodeExpression(expr.n);
                if (expr.types === null) {
                    return [...dstBytes, ...srcBytes, ...nBytes];
                }
                // 0xFC 0x0A is memory.copy; trailing two memidx bytes are
                // dst-memory and src-memory (both 0 for the default memory).
                return [...dstBytes, ...srcBytes, ...nBytes, 0xFC, 0x0A, 0x00, 0x00];
            } else if (expr instanceof IR.MemoryFill) {
                const dstBytes = encodeExpression(expr.dst);
                const valBytes = encodeExpression(expr.val);
                const nBytes = encodeExpression(expr.n);
                if (expr.types === null) {
                    return [...dstBytes, ...valBytes, ...nBytes];
                }
                // 0xFC 0x0B is memory.fill; trailing memidx (0).
                return [...dstBytes, ...valBytes, ...nBytes, 0xFC, 0x0B, 0x00];
            } else if (expr instanceof IR.StructNew) {
                const fieldBytes = expr.fieldValues.flatMap(v => encodeExpression(v));
                if (expr.types === null) return fieldBytes;
                const idx = typeIndexMap.get(expr.structType);
                return [...fieldBytes, 0xFB, 0x00, ...encodeLEBU128(idx)];
            } else if (expr instanceof IR.StructNewDefault) {
                if (expr.types === null) return [];
                const idx = typeIndexMap.get(expr.structType);
                return [0xFB, 0x01, ...encodeLEBU128(idx)];
            } else if (expr instanceof IR.StructGet) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                const idx = typeIndexMap.get(expr.structType);
                // 0xFB 0x02 = struct.get; 0x03 = struct.get_s; 0x04 = struct.get_u.
                const sub = expr.signed === undefined ? 0x02
                          : (expr.signed ? 0x03 : 0x04);
                return [
                    ...refBytes,
                    0xFB, sub,
                    ...encodeLEBU128(idx),
                    ...encodeLEBU128(expr.fieldIdx),
                ];
            } else if (expr instanceof IR.StructSet) {
                const refBytes = encodeExpression(expr.ref);
                const valBytes = encodeExpression(expr.value);
                if (expr.types === null) return [...refBytes, ...valBytes];
                const idx = typeIndexMap.get(expr.structType);
                return [
                    ...refBytes, ...valBytes,
                    0xFB, 0x05,
                    ...encodeLEBU128(idx),
                    ...encodeLEBU128(expr.fieldIdx),
                ];
            } else if (expr instanceof IR.ArrayNew) {
                const initBytes = encodeExpression(expr.init);
                const lenBytes = encodeExpression(expr.length);
                if (expr.types === null) return [...initBytes, ...lenBytes];
                const idx = typeIndexMap.get(expr.arrayType);
                return [...initBytes, ...lenBytes, 0xFB, 0x06, ...encodeLEBU128(idx)];
            } else if (expr instanceof IR.ArrayNewDefault) {
                const lenBytes = encodeExpression(expr.length);
                if (expr.types === null) return lenBytes;
                const idx = typeIndexMap.get(expr.arrayType);
                return [...lenBytes, 0xFB, 0x07, ...encodeLEBU128(idx)];
            } else if (expr instanceof IR.ArrayNewFixed) {
                const valBytes = expr.values.flatMap(v => encodeExpression(v));
                if (expr.types === null) return valBytes;
                const idx = typeIndexMap.get(expr.arrayType);
                return [
                    ...valBytes,
                    0xFB, 0x08,
                    ...encodeLEBU128(idx),
                    ...encodeLEBU128(expr.values.length),
                ];
            } else if (expr instanceof IR.ArrayGet) {
                const refBytes = encodeExpression(expr.ref);
                const idxBytes = encodeExpression(expr.index);
                if (expr.types === null) return [...refBytes, ...idxBytes];
                const tIdx = typeIndexMap.get(expr.arrayType);
                // 0xFB 0x0B = array.get; 0x0C = array.get_s; 0x0D = array.get_u.
                const sub = expr.signed === undefined ? 0x0B
                          : (expr.signed ? 0x0C : 0x0D);
                return [...refBytes, ...idxBytes, 0xFB, sub, ...encodeLEBU128(tIdx)];
            } else if (expr instanceof IR.ArraySet) {
                const refBytes = encodeExpression(expr.ref);
                const idxBytes = encodeExpression(expr.index);
                const valBytes = encodeExpression(expr.value);
                if (expr.types === null) {
                    return [...refBytes, ...idxBytes, ...valBytes];
                }
                const tIdx = typeIndexMap.get(expr.arrayType);
                return [
                    ...refBytes, ...idxBytes, ...valBytes,
                    0xFB, 0x0E, ...encodeLEBU128(tIdx),
                ];
            } else if (expr instanceof IR.ArrayLen) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                return [...refBytes, 0xFB, 0x0F]; // array.len takes no immediate
            } else if (expr instanceof IR.ArrayCopy) {
                const dstB = encodeExpression(expr.dst);
                const dstOB = encodeExpression(expr.dstOffset);
                const srcB = encodeExpression(expr.src);
                const srcOB = encodeExpression(expr.srcOffset);
                const nB = encodeExpression(expr.n);
                if (expr.types === null) {
                    return [...dstB, ...dstOB, ...srcB, ...srcOB, ...nB];
                }
                return [
                    ...dstB, ...dstOB, ...srcB, ...srcOB, ...nB,
                    0xFB, 0x11,
                    ...encodeLEBU128(typeIndexMap.get(expr.dstType)),
                    ...encodeLEBU128(typeIndexMap.get(expr.srcType)),
                ];
            } else if (expr instanceof IR.ArrayFill) {
                const refB = encodeExpression(expr.ref);
                const offB = encodeExpression(expr.offset);
                const valB = encodeExpression(expr.val);
                const nB = encodeExpression(expr.n);
                if (expr.types === null) {
                    return [...refB, ...offB, ...valB, ...nB];
                }
                return [
                    ...refB, ...offB, ...valB, ...nB,
                    0xFB, 0x10,
                    ...encodeLEBU128(typeIndexMap.get(expr.arrayType)),
                ];
            } else if (expr instanceof IR.AnyConvertExtern) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                return [...refBytes, 0xFB, 0x1A];
            } else if (expr instanceof IR.ExternConvertAny) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                return [...refBytes, 0xFB, 0x1B];
            } else if (expr instanceof IR.RefNull) {
                return [0xD0, ...encodeHeapType(expr.heapType)];
            } else if (expr instanceof IR.RefIsNull) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                return [...refBytes, 0xD1];
            } else if (expr instanceof IR.RefAsNonNull) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                return [...refBytes, 0xD4];
            } else if (expr instanceof IR.RefEq) {
                const aBytes = encodeExpression(expr.refA);
                const bBytes = encodeExpression(expr.refB);
                if (expr.types === null) return [...aBytes, ...bBytes];
                return [...aBytes, ...bBytes, 0xD3];
            } else if (expr instanceof IR.RefCast) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                // 0xFB 0x16 = ref.cast (ref ht); 0x17 = ref.cast (ref null ht).
                const sub = expr.targetRefType.nullable ? 0x17 : 0x16;
                return [
                    ...refBytes, 0xFB, sub,
                    ...encodeHeapType(expr.targetRefType.heapType),
                ];
            } else if (expr instanceof IR.RefTest) {
                const refBytes = encodeExpression(expr.ref);
                if (expr.types === null) return refBytes;
                // 0xFB 0x14 = ref.test (ref ht); 0x15 = ref.test (ref null ht).
                const sub = expr.targetRefType.nullable ? 0x15 : 0x14;
                return [
                    ...refBytes, 0xFB, sub,
                    ...encodeHeapType(expr.targetRefType.heapType),
                ];
            } else if (expr instanceof IR.BytesLiteral
                    || expr instanceof IR.MutableBytesLiteral) {
                const addr = bytesAddrMap.get(expr);
                assert(addr !== undefined,
                    'BytesLiteral used without a memorySpec on Program');
                return [0x41, ...encodeLEBS128(addr)]; // i32.const <addr>
            } else if (expr instanceof IR.HeapBase) {
                return [0x41, ...encodeLEBS128(heapBaseAddr)]; // i32.const heap_base
            } else if (expr instanceof IR.StackSlotAddr) {
                const off = slotOffsets.get(expr.slot);
                assert(off !== undefined,
                    () => `StackSlotAddr: slot ${expr.slot.name} not laid out`);
                // Address relative to the saved-SP local (frame top), not
                // current SP — the static frame must stay reachable even
                // after Allocas have moved SP. Effective address:
                //   saved_sp + (off - frameSize)
                assert(currentSavedSpIdx >= 0,
                    'StackSlotAddr in function without a frame');
                const adj = off - currentFrameSize;
                if (adj === 0) {
                    return [0x20, ...encodeLEBU128(currentSavedSpIdx)];
                }
                return [
                    0x20, ...encodeLEBU128(currentSavedSpIdx),
                    0x41, ...encodeLEBS128(adj),
                    0x6A, // i32.add
                ];
            } else if (expr instanceof IR.Alloca) {
                assert(stackPointerIndex >= 0,
                    'Alloca requires memorySpec.stackPages > 0');
                // Compute size on the wasm stack — either a constant
                // (static) or the size-expr's value (dynamic). Then round
                // up to align, subtract from sp, set sp, return new sp.
                const align = expr.align;
                let sizeBytes;
                if (typeof expr.size === 'number') {
                    const aligned = (expr.size + align - 1) & ~(align - 1);
                    sizeBytes = [0x41, ...encodeLEBS128(aligned)];
                } else {
                    // Dynamic: compute (size + (align-1)) & ~(align-1).
                    sizeBytes = [
                        ...encodeExpression(expr.size),
                        0x41, ...encodeLEBS128(align - 1),  // i32.const align-1
                        0x6A,                                // i32.add
                        0x41, ...encodeLEBS128(~(align - 1)),// i32.const ~(align-1) (signed)
                        0x71,                                // i32.and
                    ];
                }
                return [
                    0x23, ...encodeLEBU128(stackPointerIndex), // global.get $sp
                    ...sizeBytes,
                    0x6B,                                       // i32.sub
                    0x24, ...encodeLEBU128(stackPointerIndex), // global.set $sp
                    0x23, ...encodeLEBU128(stackPointerIndex), // global.get $sp
                ];
            } else if (expr instanceof IR.Return) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                // Restore SP before returning, if we're inside a frame-owning
                // function. The currentReturnRestoreBytes state is set in the
                // function-emit prelude.
                return [...argBytes, ...currentReturnRestoreBytes, 0x0F]; // return
            } else if (expr instanceof IR.Unreachable) {
                return [0x00]; // unreachable
            } else if (expr instanceof IR.Drop) {
                const sourceBytes = encodeExpression(expr.source);
                if (expr.source.types === null) return sourceBytes;
                const n = expr.source.types.length;
                return [...sourceBytes, ...Array(n).fill(0x1A)];
            } else if (expr instanceof IR.Select) {
                const trueBytes = encodeExpression(expr.ifTrue);
                const falseBytes = encodeExpression(expr.ifFalse);
                const condBytes = encodeExpression(expr.condition);
                if (expr.types === null) {
                    return [...trueBytes, ...falseBytes, ...condBytes];
                }
                // Wasm stack at the select op: ..., val1, val2, cond (top).
                // 0x1B is the legacy select for numeric types — fine for our
                // current type set (no reftype-typed select needed yet).
                return [...trueBytes, ...falseBytes, ...condBytes, 0x1B];
            } else if (expr instanceof IR.MultiValue) {
                // Stack each child's values in order; no drops.
                return expr.exprs.flatMap(e => encodeExpression(e));
            } else if (expr instanceof IR.Block) {
                // Four cases based on (hasBreak, hasContinue):
                //   both:           block <T> loop body br 0 end unreachable end
                //   break only:     block <T> body end
                //   continue only:  loop body br 0 end unreachable
                //   neither:        body              (Block is transparent)
                // In the loop forms the body falls off into a synthetic `br 0`
                // (continues), and `unreachable` after the loop makes the
                // surrounding stack polymorphic (since the loop never falls
                // off, the parent's expected result type is satisfied).
                const out = [];
                if (expr.hasBreak) {
                    out.push(0x02, ...encodeBlockType(expr.resultTypes));
                    labelStack.push({ name: expr.label, kind: 'block' });
                }
                if (expr.hasContinue) {
                    out.push(0x03, ...encodeBlockType([]));
                    labelStack.push({ name: expr.label, kind: 'loop' });
                }
                // For loop bodies the validator expects [] on fall-through
                // (the explicit `br 0` after the body is polymorphic anyway).
                // For pure-break blocks the body must satisfy the block's
                // resultTypes — that's where polymorphism matters.
                const bodyExpected = expr.hasContinue ? [] : expr.resultTypes;
                emitStatementBody(out, expr.body, bodyExpected);
                if (expr.hasContinue) {
                    out.push(0x0C, 0x00); // br 0 — fall-through implicitly continues
                    labelStack.pop();
                    out.push(0x0B); // end loop
                    out.push(0x00); // unreachable
                }
                if (expr.hasBreak) {
                    labelStack.pop();
                    out.push(0x0B); // end block
                }
                return out;
            } else if (expr instanceof IR.IfElse) {
                // Emit the condition before opening the if (matching wasm —
                // the condition is not inside the if's scope).
                const out = [...encodeExpression(expr.condition)];
                out.push(0x04, ...encodeBlockType(expr.resultTypes));
                labelStack.push({ name: null, kind: 'if' });
                emitStatementBody(out, expr.thenBody, expr.resultTypes);
                // Elide `else` when there's no else body AND the if produces
                // no result. Saves a byte per `if without else` — common.
                const omitElse = expr.elseBody.length === 0 &&
                                 expr.resultTypes.length === 0;
                if (!omitElse) {
                    out.push(0x05); // else
                    emitStatementBody(out, expr.elseBody, expr.resultTypes);
                }
                labelStack.pop();
                out.push(0x0B); // end
                return out;
            } else if (expr instanceof IR.Continue) {
                const depth = resolveLabel(expr.label, 'loop');
                assert(depth >= 0, () => `Continue: no enclosing loop labeled '${expr.label}'`);
                return [0x0C, ...encodeLEBU128(depth)];
            } else if (expr instanceof IR.Break) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                const depth = resolveLabel(expr.label, 'block');
                assert(depth >= 0, () => `Break: no enclosing block labeled '${expr.label}'`);
                return [...argBytes, 0x0C, ...encodeLEBU128(depth)];
            } else if (expr instanceof IR.BrIf) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                const condBytes = encodeExpression(expr.condition);
                const depth = resolveLabel(expr.label, 'block');
                assert(depth >= 0, () => `BrIf: no enclosing block labeled '${expr.label}'`);
                return [...argBytes, ...condBytes, 0x0D, ...encodeLEBU128(depth)];
            } else if (expr instanceof IR.Throw) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                return [...argBytes, 0x08, ...encodeLEBU128(tagIndexMap.get(expr.tag))];
            } else if (expr instanceof IR.ThrowRef) {
                const exnBytes = encodeExpression(expr.exn);
                return [...exnBytes, 0x0A];
            } else if (expr instanceof IR.TryTable) {
                const out = [];
                out.push(0x1F, ...encodeBlockType(expr.resultTypes));
                out.push(...encodeLEBU128(expr.catches.length));
                for (const c of expr.catches) {
                    if (c.kind === 'catch') {
                        out.push(0x00);
                        out.push(...encodeLEBU128(tagIndexMap.get(c.tag)));
                    } else if (c.kind === 'catch_ref') {
                        out.push(0x01);
                        out.push(...encodeLEBU128(tagIndexMap.get(c.tag)));
                    } else if (c.kind === 'catch_all') {
                        out.push(0x02);
                    } else if (c.kind === 'catch_all_ref') {
                        out.push(0x03);
                    } else {
                        throw new Error(`Unsupported catch kind: ${c.kind}`);
                    }
                    const depth = resolveLabel(c.label, 'block');
                    assert(depth >= 0,
                        () => `TryTable: no enclosing block labeled '${c.label}'`);
                    out.push(...encodeLEBU128(depth));
                }
                labelStack.push({ name: expr.label, kind: 'block' });
                emitStatementBody(out, expr.body, expr.resultTypes);
                labelStack.pop();
                out.push(0x0B); // end
                return out;
            } else if (expr instanceof IR.TryFinally) {
                throw new Error(
                    'TryFinally must be lowered before codegen. ' +
                    'CODEGEN.emit runs IR.lowerTryFinally automatically; ' +
                    'this should not happen unless emit() was bypassed.');
            } else if (expr instanceof IR.BrTable) {
                const argBytes = expr.args.flatMap(a => encodeExpression(a));
                const idxBytes = encodeExpression(expr.indexExpr);
                const tableDepths = expr.labels.map(label => {
                    const d = resolveLabel(label, 'block');
                    assert(d >= 0,
                        () => `BrTable: no enclosing block labeled '${label}'`);
                    return d;
                });
                const defaultDepth = resolveLabel(expr.defaultLabel, 'block');
                assert(defaultDepth >= 0,
                    () => `BrTable: no enclosing block labeled '${expr.defaultLabel}'`);
                return [
                    ...argBytes, ...idxBytes,
                    0x0E,
                    ...encodeLEBU128(tableDepths.length),
                    ...tableDepths.flatMap(d => encodeLEBU128(d)),
                    ...encodeLEBU128(defaultDepth),
                ];
            } else {
                throw new Error('Unsupported expression: ' + expr.constructor.name);
            }
        };

        //////////////////////////////////////////////////
        // 1: Type section
        //////////////////////////////////////////////////
        const encodeCompType = (type) => {
            if (type instanceof T.FunctionType) {
                return [
                    0x60, // func
                    ...encodeLEBU128(type.params.length),
                    ...type.params.flatMap(encodeValtype),
                    ...encodeLEBU128(type.results.length),
                    ...type.results.flatMap(encodeValtype),
                ];
            } else if (type instanceof T.StructType) {
                return [
                    0x5F, // struct
                    ...encodeLEBU128(type.fields.length),
                    ...type.fields.flatMap(f => [
                        ...encodeStorageType(f),
                        f.mutable ? 0x01 : 0x00,
                    ]),
                ];
            } else if (type instanceof T.ArrayType) {
                return [
                    0x5E, // array
                    ...encodeStorageType({
                        type: type.elementType,
                        packedKind: type.packedKind,
                    }),
                    type.mutable ? 0x01 : 0x00,
                ];
            }
            throw new Error('Unsupported type in type section: ' + type);
        };

        // Wasm types are implicitly *final* unless emitted with a `sub`
        // form. Pre-scan the typeArray to find every type that appears as
        // someone's parent — those need explicit non-final emission so a
        // child type's declaration won't fail validation. Children with a
        // parent always need `sub` regardless.
        const isParentOf = new Set();
        for (const t of typeArray) {
            if (t instanceof T.StructType && t.parent) isParentOf.add(t.parent);
        }

        const encodeSubtype = (type) => {
            if (type instanceof T.StructType && type.parent) {
                return [
                    0x50, // sub (non-final)
                    ...encodeLEBU128(1),
                    ...encodeLEBU128(typeIndexMap.get(type.parent)),
                    ...encodeCompType(type),
                ];
            }
            if (isParentOf.has(type)) {
                // Make this type non-final so a subtype can extend it.
                return [0x50, 0x00, ...encodeCompType(type)];
            }
            return encodeCompType(type);
        };

        if (sccs.length > 0) {
            // Section count is the number of REC GROUPS, not the number of
            // types — a singleton non-recursive type is its own implicit
            // rec group (encoded as a bare subtype, no 0x4E wrapper).
            const sccBytes = [];
            for (const scc of sccs) {
                if (sccHasSelfReference(scc)) {
                    sccBytes.push(0x4E, ...encodeLEBU128(scc.length));
                    for (const m of scc) sccBytes.push(...encodeSubtype(m));
                } else {
                    sccBytes.push(...encodeSubtype(scc[0]));
                }
            }
            const content = [...encodeLEBU128(sccs.length), ...sccBytes];
            appendBytes(out, section(1, content));
        }

        //////////////////////////////////////////////////
        // 2: Import section
        //////////////////////////////////////////////////
        const encodeLimits = (min, max) => {
            const hasMax = max !== undefined && max !== null;
            return [
                hasMax ? 0x01 : 0x00,
                ...encodeLEBU128(min),
                ...(hasMax ? encodeLEBU128(max) : []),
            ];
        };

        const importCount = importedFunctions.length + importedGlobals.length
            + stringValues.length + importedTables.length + importedTags.length;
        if (importCount > 0) {
            const content = [
                ...encodeLEBU128(importCount),
                ...importedFunctions.flatMap(func => [
                    ...encodeString(func.importSpec.module),
                    ...encodeString(func.importSpec.name),
                    0x00, // import kind: function
                    ...encodeLEBU128(typeIndexMap.get(func.type)),
                ]),
                ...importedTables.flatMap(table => [
                    ...encodeString(table.importSpec.module),
                    ...encodeString(table.importSpec.name),
                    0x01, // import kind: table
                    ...encodeValtype(table.refType),
                    ...encodeLimits(table.minSize, table.maxSize),
                ]),
                ...importedGlobals.flatMap(variable => [
                    ...encodeString(variable.importSpec.module),
                    ...encodeString(variable.importSpec.name),
                    0x03, // import kind: global
                    ...encodeValtype(variable.type),
                    variable.mutable ? 0x01 : 0x00,
                ]),
                ...importedTags.flatMap(tag => [
                    ...encodeString(tag.importSpec.module),
                    ...encodeString(tag.importSpec.name),
                    0x04, // import kind: tag
                    0x00, // tag attribute: exception
                    ...encodeLEBU128(typeIndexMap.get(tag.type)),
                ]),
                ...stringValues.flatMap(s => [
                    ...encodeString('#'),
                    ...encodeString(s),
                    0x03, // global
                    0x6F, // externref
                    0x00, // immutable
                ]),
            ];
            appendBytes(out, section(2, content));
        }

        //////////////////////////////////////////////////
        // 3: Function section
        //////////////////////////////////////////////////
        if (definedFunctions.length > 0) {
            const content = [
                ...encodeLEBU128(definedFunctions.length),
                ...definedFunctions.flatMap(func =>
                    encodeLEBU128(typeIndexMap.get(func.type))),
            ];
            appendBytes(out, section(3, content));
        }

        //////////////////////////////////////////////////
        // 4: Table section
        //////////////////////////////////////////////////
        if (definedTables.length > 0) {
            const content = [
                ...encodeLEBU128(definedTables.length),
                ...definedTables.flatMap(table => [
                    ...encodeValtype(table.refType),
                    ...encodeLimits(table.minSize, table.maxSize),
                ]),
            ];
            appendBytes(out, section(4, content));
        }

        //////////////////////////////////////////////////
        // 5: Memory section
        //////////////////////////////////////////////////
        if (memorySpec) {
            const hasMax = memorySpec.maxPages !== undefined && memorySpec.maxPages !== null;
            const flags = hasMax ? 0x01 : 0x00;
            // When stackPages > 0 we own the layout; minPages is
            // recomputed from staticDataEnd + stackPages + minHeapPages and
            // any explicit memorySpec.minPages becomes an effective lower
            // bound (max of both).
            let minPages;
            if (stackPages > 0 || minHeapPages > 0) {
                const explicit = memorySpec.minPages || 0;
                minPages = Math.max(computedMinPages, explicit);
            } else {
                assert(memorySpec.minPages !== undefined &&
                       memorySpec.minPages !== null,
                    'memorySpec.minPages required when stackPages/minHeapPages absent');
                minPages = memorySpec.minPages;
            }
            const content = [
                ...encodeLEBU128(1), // 1 memory entry
                flags,
                ...encodeLEBU128(minPages),
                ...(hasMax ? encodeLEBU128(memorySpec.maxPages) : []),
            ];
            appendBytes(out, section(5, content));
        }

        //////////////////////////////////////////////////
        // 13: Tag section (post-MVP exception-handling proposal).
        // Per the proposal, it sits between Memory (5) and Global (6) in
        // section order even though its ID byte is 13.
        //////////////////////////////////////////////////
        if (definedTags.length > 0) {
            const content = [
                ...encodeLEBU128(definedTags.length),
                ...definedTags.flatMap(tag => [
                    0x00, // attribute: exception
                    ...encodeLEBU128(typeIndexMap.get(tag.type)),
                ]),
            ];
            appendBytes(out, section(13, content));
        }

        //////////////////////////////////////////////////
        // 6: Global section
        //////////////////////////////////////////////////
        if (definedGlobals.length > 0) {
            const content = [
                ...encodeLEBU128(definedGlobals.length),
                ...definedGlobals.flatMap(variable => {
                    assert(variable.init, () =>
                        `Defined global ${variable.name} has no initializer`);
                    return [
                        ...encodeValtype(variable.type),
                        variable.mutable ? 0x01 : 0x00,
                        ...encodeExpression(variable.init),
                        0x0B, // end of init expression
                    ];
                }),
            ];
            appendBytes(out, section(6, content));
        }

        //////////////////////////////////////////////////
        // 7: Export section
        //////////////////////////////////////////////////
        const exports = [];
        for (const func of functions) {
            if (func.exportSpec) {
                exports.push({
                    name: func.exportSpec.name,
                    kind: 0x00, // function
                    index: funcIndexMap.get(func),
                });
            }
        }
        for (const variable of variables) {
            if (variable.exportSpec) {
                exports.push({
                    name: variable.exportSpec.name,
                    kind: 0x03, // global
                    index: globalIndexMap.get(variable),
                });
            }
        }
        for (const table of tables) {
            if (table.exportSpec) {
                exports.push({
                    name: table.exportSpec.name,
                    kind: 0x01, // table
                    index: tableIndexMap.get(table),
                });
            }
        }
        if (memorySpec && memorySpec.exportName) {
            exports.push({
                name: memorySpec.exportName,
                kind: 0x02, // memory
                index: 0,   // memidx 0
            });
        }
        for (const tag of programTags) {
            if (tag.exportSpec) {
                exports.push({
                    name: tag.exportSpec.name,
                    kind: 0x04, // tag
                    index: tagIndexMap.get(tag),
                });
            }
        }
        if (exports.length > 0) {
            const content = [
                ...encodeLEBU128(exports.length),
                ...exports.flatMap(exp => [
                    ...encodeString(exp.name),
                    exp.kind,
                    ...encodeLEBU128(exp.index),
                ]),
            ];
            appendBytes(out, section(7, content));
        }

        //////////////////////////////////////////////////
        // 9: Element section
        //////////////////////////////////////////////////
        const elemSegments = [...program.elements];
        if (autoTableSegment) elemSegments.push(autoTableSegment);
        const totalElemSegs = elemSegments.length + (declarativeFuncs.length > 0 ? 1 : 0);
        if (totalElemSegs > 0) {
            const content = [...encodeLEBU128(totalElemSegs)];
            for (const seg of elemSegments) {
                // Form 2: active, explicit table, by funcidx (elemkind 0).
                content.push(0x02);
                content.push(...encodeLEBU128(tableIndexMap.get(seg.table)));
                content.push(0x41, ...encodeLEBS128(seg.offset), 0x0B); // i32.const offset; end
                content.push(0x00); // elemkind: funcref
                content.push(...encodeLEBU128(seg.functions.length));
                for (const f of seg.functions) {
                    content.push(...encodeLEBU128(funcIndexMap.get(f)));
                }
            }
            if (declarativeFuncs.length > 0) {
                // Form 3: declarative, by funcidx, elemkind funcref.
                content.push(0x03, 0x00);
                content.push(...encodeLEBU128(declarativeFuncs.length));
                for (const f of declarativeFuncs) {
                    content.push(...encodeLEBU128(funcIndexMap.get(f)));
                }
            }
            appendBytes(out, section(9, content));
        }

        //////////////////////////////////////////////////
        // 10: Code section
        //////////////////////////////////////////////////
        const encodeLocalDecls = (locals) => {
            // Group consecutive locals that share a wasm slot type — multiple
            // IR types (e.g. U8/I8/I32) all collapse to wasm i32.
            const groups = [];
            for (const local of locals) {
                const slot = local.type.slotType || local.type;
                const last = groups[groups.length - 1];
                if (last && last.slot === slot) {
                    last.count++;
                } else {
                    groups.push({ slot, count: 1 });
                }
            }
            return [
                ...encodeLEBU128(groups.length),
                ...groups.flatMap(g => [
                    ...encodeLEBU128(g.count), ...encodeValtype(g.slot),
                ]),
            ];
        };

        if (definedFunctions.length > 0) {
            const codeEntries = definedFunctions.map(func => {
                assert(func.body, () => `Function ${func.name} has no body`);
                // Locals are addressed by index: params first (0..N-1), then locals.
                currentLocalIndexMap = new Map();
                let idx = 0;
                for (const p of func.params) currentLocalIndexMap.set(p, idx++);
                for (const l of func.locals) currentLocalIndexMap.set(l, idx++);

                // Frame-owning function? Either has a static frame or
                // contains alloca. Synthesize a `_saved_sp` local at the
                // end of the local index space, and emit prologue +
                // SP-restoring epilogue/return prefix.
                const frameSize = frameSizeByFunc.get(func) || 0;
                const containsAlloca = func.body.containsAlloca;
                const needsFrame = frameSize > 0 || containsAlloca;
                let prologueBytes = [];
                let restoreBytes = [];
                let extraLocals = [];
                if (needsFrame) {
                    assert(stackPointerIndex >= 0,
                        () => `Function ${func.name}: stack frame needed but ` +
                        `no memorySpec.stackPages set`);
                    const savedSpLocal = new IR.LocalVariable(
                        null, true, '_saved_sp', T.I32);
                    currentLocalIndexMap.set(savedSpLocal, idx++);
                    extraLocals = [savedSpLocal];
                    const spIdxBytes = encodeLEBU128(stackPointerIndex);
                    const savedIdx = currentLocalIndexMap.get(savedSpLocal);
                    currentSavedSpIdx = savedIdx;
                    currentFrameSize = frameSize;
                    const savedIdxBytes = encodeLEBU128(savedIdx);
                    // saved_sp = sp; sp -= frameSize;  (frameSize may be 0
                    // if only alloca uses the stack — in that case prologue
                    // is just the SP save).
                    prologueBytes = [
                        0x23, ...spIdxBytes,                  // global.get $sp
                        0x21, ...savedIdxBytes,               // local.set saved_sp
                    ];
                    if (frameSize > 0) {
                        prologueBytes.push(
                            0x23, ...spIdxBytes,              // global.get $sp
                            0x41, ...encodeLEBS128(frameSize),// i32.const frameSize
                            0x6B,                              // i32.sub
                            0x24, ...spIdxBytes,              // global.set $sp
                        );
                    }
                    // Restore: sp = saved_sp.
                    restoreBytes = [
                        0x20, ...savedIdxBytes,               // local.get saved_sp
                        0x24, ...spIdxBytes,                  // global.set $sp
                    ];
                }
                currentReturnRestoreBytes = restoreBytes;

                labelStack.length = 0;
                const bodyEncoded = encodeExpression(func.body);
                // Fall-through epilogue: if the body's last expression is
                // not divergent (i.e. control can reach the end of the
                // function), we need to restore SP before the implicit
                // return. We emit the restore unconditionally — wasm's
                // polymorphic-stack rule covers the divergent case.
                const fallThroughRestore =
                    needsFrame && func.body.types !== null ? restoreBytes : [];

                const bodyBytes = [
                    ...encodeLocalDecls([...func.locals, ...extraLocals]),
                    ...prologueBytes,
                    ...bodyEncoded,
                    ...fallThroughRestore,
                    0x0B, // end of function body
                ];
                currentLocalIndexMap = null;
                currentReturnRestoreBytes = [];
                currentSavedSpIdx = -1;
                currentFrameSize = 0;
                return [...encodeLEBU128(bodyBytes.length), ...bodyBytes];
            });
            const content = [
                ...encodeLEBU128(definedFunctions.length),
                ...codeEntries.flat(),
            ];
            appendBytes(out, section(10, content));
        }

        //////////////////////////////////////////////////
        // 11: Data section
        //////////////////////////////////////////////////
        if (dataSegments.length > 0) {
            const content = [
                ...encodeLEBU128(dataSegments.length),
                ...dataSegments.flatMap(seg => [
                    0x00, // active segment, memidx 0 (default form)
                    // offset expression: i32.const <addr>; end
                    0x41, ...encodeLEBS128(seg.offset), 0x0B,
                    // bytes
                    ...encodeLEBU128(seg.bytes.length),
                    ...seg.bytes,
                ]),
            ];
            appendBytes(out, section(11, content));
        }

        //////////////////////////////////////////////////
        // 0: Custom sections (id 0). Frontend-supplied (name, bytes) pairs.
        // Emitted in array order, after all numbered sections. Bytes are an
        // opaque payload — codegen just frames them with the standard
        // length-prefixed UTF-8 name header.
        //////////////////////////////////////////////////
        for (const cs of program.customSections) {
            const payload = cs.bytes instanceof Uint8Array ? Array.from(cs.bytes) : [...cs.bytes];
            const content = [...encodeString(cs.name), ...payload];
            appendBytes(out, section(0, content));
        }

        return new Uint8Array(out);
    }

    return {
        emit,
        encodeLEBU128,
        encodeLEBS128,
        encodeString,
    };
})();

// RUNTIME: a tiny JS-side runtime for executing modules emitted by CODEGEN.
//
// Provides:
//   - `compileOptions`: pass to `new WebAssembly.Module(bytes, compileOptions)`
//     so the `'#'` string-import module resolves automatically (each import's
//     name becomes its value via the JS-Strings importedStringConstants
//     proposal).
//   - `newRuntime({ onWrite } = {})`: returns `{ imports, stdout, stderr,
//     instantiate(bytes, extraImports?) }`.
//       - When `onWrite(fd, bytes)` is provided, every write call is routed
//         to it as a normalized `Uint8Array`. The capture getters then
//         return the empty string.
//       - When omitted, the runtime captures fd 1 → `stdout`, fd 2 →
//         `stderr` (other fds dropped). Each `newRuntime` call has fresh
//         buffers — useful for tests.
//   - The single host function `guc.write(fd, data)` accepts a JS string or
//     ArrayBuffer/typed array/DataView; the runtime always normalizes to
//     Uint8Array before passing through. We use the `guc` module name (not
//     `env`) to avoid colliding with emscripten/wasi conventions.
const RUNTIME = (() => {
    const compileOptions = { importedStringConstants: '#' };

    function toBytes(data) {
        if (typeof data === 'string') return new TextEncoder().encode(data);
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        throw new Error('write: unsupported data type');
    }

    function decodeBufs(bufs) {
        let total = 0;
        for (const b of bufs) total += b.length;
        const merged = new Uint8Array(total);
        let off = 0;
        for (const b of bufs) { merged.set(b, off); off += b.length; }
        return new TextDecoder().decode(merged);
    }

    // Static host primitives that don't depend on per-runtime state. These
    // let a wasm module use JS data structures (arrays, objects) directly via
    // externref, postponing the decision between linear memory and wasm GC.
    // Numeric conversions are unchecked: passing nonsense to them will give
    // you nonsense back (NaN | 0, BigInt(undefined) → throws, etc.).
    const STATIC_GUC = Object.freeze({
        // externref ↔ scalar
        externref_to_i32: (x) => Number(x) | 0,
        externref_to_i64: (x) => BigInt(x),
        externref_to_f32: (x) => Math.fround(Number(x)),
        externref_to_f64: (x) => Number(x),
        i32_to_externref: (x) => x,
        i64_to_externref: (x) => x,
        f32_to_externref: (x) => x,
        f64_to_externref: (x) => x,
        // JS array as the array primitive
        array_new:    () => [],
        array_push:   (a, v) => { a.push(v); },
        array_pop:    (a) => a.pop(),
        array_length: (a) => a.length,
        array_get:    (a, i) => a[i],
        array_set:    (a, i, v) => { a[i] = v; },
        // Null-prototype JS object as the dictionary primitive
        object_new:    () => Object.create(null),
        object_set:    (o, k, v) => { o[k] = v; },
        object_get:    (o, k) => o[k],
        object_delete: (o, k) => { delete o[k]; },
    });

    function newRuntime(options) {
        const opts = options || {};
        const stdoutBufs = [];
        const stderrBufs = [];
        const handler = opts.onWrite || ((fd, bytes) => {
            if (fd === 1) stdoutBufs.push(bytes);
            else if (fd === 2) stderrBufs.push(bytes);
            // Other fds: silently dropped.
        });
        const write = (fd, data) => handler(fd, toBytes(data));
        return {
            imports: { guc: { ...STATIC_GUC, write } },
            get stdout() { return decodeBufs(stdoutBufs); },
            get stderr() { return decodeBufs(stderrBufs); },
            instantiate(bytes, extraImports) {
                const mod = new WebAssembly.Module(bytes, compileOptions);
                const imports = {};
                for (const [m, e] of Object.entries(this.imports)) {
                    imports[m] = { ...e };
                }
                if (extraImports) {
                    for (const [m, e] of Object.entries(extraImports)) {
                        imports[m] = { ...(imports[m] || {}), ...e };
                    }
                }
                return new WebAssembly.Instance(mod, imports);
            },
        };
    }

    return { compileOptions, newRuntime };
})();

return {
    Loc,
    UserError,
    withErrorPool,
    reportError,
    assert,
    TreeBag,
    T,
    IR,
    OPTIMIZER,
    CODEGEN,
    RUNTIME,
};

});
