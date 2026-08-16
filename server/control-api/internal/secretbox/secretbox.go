// Package secretbox encrypts settings secrets with AES-256-GCM.
// The master key never enters the database, logs, or API responses.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
)

var (
	ErrInvalidMasterKey = errors.New("SETTINGS_MASTER_KEY must be 64 hexadecimal characters")
	ErrUnavailable      = errors.New("settings master key is not configured")
	ErrCiphertext       = errors.New("ciphertext is invalid")
)

const (
	keySize     = 32
	nonceSize   = 12
	versionSize = 1
	versionV1   = 1
)

type Box struct {
	key        []byte
	keyVersion int
}

func ParseMasterKey(value string) ([]byte, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil, ErrInvalidMasterKey
	}
	decoded, err := hex.DecodeString(trimmed)
	if err != nil || len(decoded) != keySize {
		return nil, ErrInvalidMasterKey
	}
	return decoded, nil
}

func New(key []byte) (*Box, error) {
	if len(key) != keySize {
		return nil, ErrInvalidMasterKey
	}
	copied := make([]byte, keySize)
	copy(copied, key)
	return &Box{key: copied, keyVersion: 1}, nil
}

func (box *Box) KeyVersion() int {
	if box == nil {
		return 0
	}
	return box.keyVersion
}

func (box *Box) Seal(plaintext []byte) ([]byte, error) {
	if box == nil {
		return nil, ErrUnavailable
	}
	block, err := aes.NewCipher(box.key)
	if err != nil {
		return nil, ErrUnavailable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrUnavailable
	}
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, ErrUnavailable
	}
	sealed := aead.Seal(nil, nonce, plaintext, nil)
	out := make([]byte, 0, versionSize+nonceSize+len(sealed))
	out = append(out, versionV1)
	out = append(out, nonce...)
	out = append(out, sealed...)
	return out, nil
}

func (box *Box) Open(ciphertext []byte) ([]byte, error) {
	if box == nil {
		return nil, ErrUnavailable
	}
	if len(ciphertext) < versionSize+nonceSize+16 || ciphertext[0] != versionV1 {
		return nil, ErrCiphertext
	}
	block, err := aes.NewCipher(box.key)
	if err != nil {
		return nil, ErrUnavailable
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrUnavailable
	}
	nonce := ciphertext[versionSize : versionSize+nonceSize]
	plaintext, err := aead.Open(nil, nonce, ciphertext[versionSize+nonceSize:], nil)
	if err != nil {
		return nil, ErrCiphertext
	}
	return plaintext, nil
}
