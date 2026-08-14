// Package password provides bounded Argon2id password hashing and verification.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

var (
	ErrInvalidPassword = errors.New("invalid password")
	ErrInvalidEncoded  = errors.New("invalid encoded password")
)

const (
	formatName       = "argon2id"
	formatVersion    = 19
	passwordMinRunes = 12
	passwordMaxBytes = 1024

	saltSize = 16
	hashSize = 32

	currentMemory      = 19 * 1024
	currentIterations  = 2
	currentParallelism = 1

	maxMemory      = 256 * 1024
	maxIterations  = 10
	maxParallelism = 16
	maxEncodedSize = 256
)

var rawBase64 = base64.RawStdEncoding.Strict()

type parameters struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
}

// Hash returns a canonical Argon2id password hash with a fresh random salt.
func Hash(plain string) (string, error) {
	if err := validatePassword(plain); err != nil {
		return "", err
	}

	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}

	digest := argon2.IDKey(
		[]byte(plain),
		salt,
		currentIterations,
		currentMemory,
		currentParallelism,
		hashSize,
	)

	return "$" + formatName + "$v=" + strconv.Itoa(formatVersion) +
		"$m=" + strconv.Itoa(currentMemory) + ",t=" + strconv.Itoa(currentIterations) +
		",p=" + strconv.Itoa(currentParallelism) + "$" +
		rawBase64.EncodeToString(salt) + "$" + rawBase64.EncodeToString(digest), nil
}

// Verify reports whether plain matches encoded and whether encoded uses older
// parameters than the current password hashing configuration.
func Verify(encoded, plain string) (match bool, rehash bool, err error) {
	params, salt, expected, err := parseEncoded(encoded)
	if err != nil {
		return false, false, err
	}
	if err := validatePassword(plain); err != nil {
		return false, false, err
	}

	actual := argon2.IDKey(
		[]byte(plain),
		salt,
		params.iterations,
		params.memory,
		params.parallelism,
		hashSize,
	)

	return subtle.ConstantTimeCompare(actual, expected) == 1, needsRehash(params), nil
}

func validatePassword(plain string) error {
	if !utf8.ValidString(plain) || len(plain) > passwordMaxBytes || utf8.RuneCountInString(plain) < passwordMinRunes {
		return ErrInvalidPassword
	}
	return nil
}

func parseEncoded(encoded string) (parameters, []byte, []byte, error) {
	if len(encoded) > maxEncodedSize {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}

	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != formatName || parts[2] != "v=19" {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}

	params, err := parseParameters(parts[3])
	if err != nil {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}

	if len(parts[4]) != 22 || len(parts[5]) != 43 {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}
	salt, err := rawBase64.DecodeString(parts[4])
	if err != nil || len(salt) != saltSize {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}
	expected, err := rawBase64.DecodeString(parts[5])
	if err != nil || len(expected) != hashSize {
		return parameters{}, nil, nil, ErrInvalidEncoded
	}

	return params, salt, expected, nil
}

func parseParameters(encoded string) (parameters, error) {
	fields := strings.Split(encoded, ",")
	if len(fields) != 3 {
		return parameters{}, ErrInvalidEncoded
	}

	memory, ok := parseParameter(fields[0], "m=")
	if !ok || memory == 0 || memory > maxMemory {
		return parameters{}, ErrInvalidEncoded
	}
	iterations, ok := parseParameter(fields[1], "t=")
	if !ok || iterations == 0 || iterations > maxIterations {
		return parameters{}, ErrInvalidEncoded
	}
	parallelism, ok := parseParameter(fields[2], "p=")
	if !ok || parallelism == 0 || parallelism > maxParallelism {
		return parameters{}, ErrInvalidEncoded
	}

	return parameters{
		memory:      uint32(memory),
		iterations:  uint32(iterations),
		parallelism: uint8(parallelism),
	}, nil
}

func parseParameter(field, prefix string) (uint64, bool) {
	if !strings.HasPrefix(field, prefix) || len(field) == len(prefix) {
		return 0, false
	}
	value := field[len(prefix):]
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	parsed, err := strconv.ParseUint(value, 10, 32)
	return parsed, err == nil
}

func needsRehash(params parameters) bool {
	return params.memory != currentMemory ||
		params.iterations != currentIterations ||
		params.parallelism != currentParallelism
}
