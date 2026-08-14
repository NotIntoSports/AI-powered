# Task 3 Report: Argon2id Password Service

Date: 2026-08-14

## Result

Implemented the isolated `internal/password` Argon2id password service using the already pinned `golang.org/x/crypto v0.54.0` dependency. The service emits the required canonical format:

`$argon2id$v=19$m=19456,t=2,p=1$<base64-salt>$<base64-hash>`

The expected indirect `golang.org/x/sys v0.47.0` requirement was added by offline `go mod tidy`.

## TDD evidence

### RED: missing implementation

After adding the tests before production code, this command was run with Go 1.26.5:

```text
go test ./internal/password -v
```

It failed because the requested API did not exist:

```text
internal\password\password_test.go:12:18: undefined: Hash
internal\password\password_test.go:17:29: undefined: Verify
internal\password\password_test.go:22:19: undefined: Verify
internal\password\password_test.go:47:21: undefined: ErrInvalidPassword
internal\password\password_test.go:70:23: undefined: ErrInvalidEncoded
FAIL github.com/ai-interviewer/ai-powered/control-api/internal/password [build failed]
```

### RED: implementation compile failure

The first implementation used a named result called `needsRehash`, which shadowed the helper function. The focused test then returned:

```text
internal\password\password.go:94:60: invalid operation: cannot call needsRehash (variable of type bool): bool is not a function
```

The named result was renamed to `rehash` with `apply_patch`.

## GREEN verification

All commands used the portable Go 1.26.5 toolchain with `GOPROXY=off` and the existing module cache.

Offline module tidy:

```text
go mod tidy
EXIT=0
```

Focused Task 3 suite:

```text
go test ./internal/password -v
...
--- PASS: TestMalformedEncodedPasswordsReturnStableError
    --- PASS: bad_base64
    --- PASS: wrong_version
    --- PASS: missing_fields
    --- PASS: oversized_memory
--- PASS: TestVerifyRejectsEmptyPassword
--- PASS: TestHashRejectsPasswordOver1024UTF8Bytes
--- PASS: TestVerifyRejectsPasswordOver1024UTF8Bytes
--- PASS: TestVerifyReportsRehashForDifferentParameters
--- PASS: TestConcurrentHashAndVerify
PASS
ok github.com/ai-interviewer/ai-powered/control-api/internal/password 0.740s
EXIT=0
```

Full test suite:

```text
go test ./...
? github.com/ai-interviewer/ai-powered/control-api/cmd/control-api [no test files]
ok github.com/ai-interviewer/ai-powered/control-api/internal/config (cached)
ok github.com/ai-interviewer/ai-powered/control-api/internal/database (cached)
ok github.com/ai-interviewer/ai-powered/control-api/internal/httpapi (cached)
ok github.com/ai-interviewer/ai-powered/control-api/internal/password 0.528s
ok github.com/ai-interviewer/ai-powered/control-api/openapi (cached)
TEST_EXIT=0
```

Vet:

```text
go vet ./...
VET_EXIT=0
```

## Race test status

The required exact race command was attempted:

```text
go test ./internal/password -race -v
```

With the default portable-toolchain environment it returned:

```text
go: -race requires cgo; enable cgo by setting CGO_ENABLED=1
EXIT=2
```

With `CGO_ENABLED=1`, the environment has no C compiler:

```text
cgo: C compiler "gcc" not found: exec: "gcc": executable file not found in %PATH%
FAIL github.com/ai-interviewer/ai-powered/control-api/internal/password [build failed]
EXIT=1
```

No GCC, Clang, or MSVC compiler was found at the standard Windows locations. The race test is therefore environment-blocked, not code-verified.

## Files

- `server/control-api/internal/password/password.go`: bounded Argon2id hashing, strict parsing, validation, rehash detection, and constant-time verification.
- `server/control-api/internal/password/password_test.go`: TDD coverage for hashing, unique salts, wrong passwords, Unicode/byte limits, malformed encodings, oversized parameters, rehash detection, and concurrent verification.
- `server/control-api/go.mod`: expected indirect `golang.org/x/sys v0.47.0` entry required by the existing `x/crypto` Argon2 implementation.

## Self-review

- Uses 16 cryptographically random salt bytes and a 32-byte Argon2id output.
- Uses 19 MiB, two iterations, and one thread for new hashes.
- Rejects passwords below 12 Unicode characters or above 1,024 UTF-8 bytes.
- Accepts only the canonical Argon2id format with version 19, exact parameter field order, raw base64, 16-byte salt, and 32-byte digest.
- Rejects memory above 256 MiB, iterations above 10, and parallelism above 16 before calling Argon2id.
- Uses `subtle.ConstantTimeCompare` for digest comparison.
- Returns stable `ErrInvalidPassword` and `ErrInvalidEncoded` sentinel errors.
- No database, HTTP, OpenAPI, client, or application documentation files were changed.

## Concerns

The only unresolved concern is that `go test ./internal/password -race -v` could not execute because this Windows environment lacks cgo and a C compiler. Normal focused tests, the full Go test suite, and `go vet ./...` pass with the pinned toolchain and offline module resolution.
