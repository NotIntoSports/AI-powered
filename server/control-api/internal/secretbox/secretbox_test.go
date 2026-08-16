package secretbox

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseMasterKeyRejectsNonHexAndWrongLength(t *testing.T) {
	if _, err := ParseMasterKey(""); err != ErrInvalidMasterKey {
		t.Fatalf("empty: %v", err)
	}
	if _, err := ParseMasterKey("not-hex"); err != ErrInvalidMasterKey {
		t.Fatalf("not hex: %v", err)
	}
	if _, err := ParseMasterKey(strings.Repeat("ab", 16)); err != ErrInvalidMasterKey {
		t.Fatalf("32 hex chars: %v", err)
	}
}

func TestSealOpenRoundTripAndRejectsTamper(t *testing.T) {
	key, err := ParseMasterKey(strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	box, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal([]byte("rtc-app-key"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, []byte("rtc-app-key")) {
		t.Fatal("plaintext leaked into ciphertext")
	}
	opened, err := box.Open(sealed)
	if err != nil || string(opened) != "rtc-app-key" {
		t.Fatalf("opened=%q err=%v", opened, err)
	}
	sealed[len(sealed)-1] ^= 0x01
	if _, err := box.Open(sealed); err != ErrCiphertext {
		t.Fatalf("tamper err=%v", err)
	}
}

func TestNilBoxIsUnavailable(t *testing.T) {
	var box *Box
	if _, err := box.Seal([]byte("x")); err != ErrUnavailable {
		t.Fatalf("seal err=%v", err)
	}
	if _, err := box.Open([]byte{1, 2, 3}); err != ErrUnavailable {
		t.Fatalf("open err=%v", err)
	}
}
