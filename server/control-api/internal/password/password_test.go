package password

import (
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	encoded, err := Hash("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}

	match, needsRehash, err := Verify(encoded, "correct horse battery staple")
	if err != nil || !match || needsRehash {
		t.Fatalf("match=%v rehash=%v err=%v", match, needsRehash, err)
	}

	wrong, _, err := Verify(encoded, "wrong password")
	if err != nil {
		t.Fatal(err)
	}
	if wrong {
		t.Fatal("wrong password matched")
	}
}

func TestHashUsesUniqueSalt(t *testing.T) {
	a, err := Hash("same password")
	if err != nil {
		t.Fatal(err)
	}
	b, err := Hash("same password")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("hashes must differ")
	}
}

func TestHashRejectsShortPassword(t *testing.T) {
	_, err := Hash("1234567")
	if !errors.Is(err, ErrInvalidPassword) {
		t.Fatalf("expected ErrInvalidPassword, got %v", err)
	}
}

func TestHashAcceptsEightCharacterPassword(t *testing.T) {
	encoded, err := Hash("12345678")
	if err != nil {
		t.Fatal(err)
	}
	match, _, err := Verify(encoded, "12345678")
	if err != nil || !match {
		t.Fatalf("match=%v err=%v", match, err)
	}
}

func TestMalformedEncodedPasswordsReturnStableError(t *testing.T) {
	valid := testEncoded("m=19456,t=2,p=1")
	tests := map[string]string{
		"bad base64":       strings.Replace(valid, "AAAAAAAAAAAAAAAAAAAAAA", "!!!!!!!!!!!!!!!!!!!!!!", 1),
		"wrong version":    strings.Replace(valid, "$v=19$", "$v=18$", 1),
		"missing fields":   strings.Replace(valid, "$m=19456,t=2,p=1$", "$m=19456,t=2$", 1),
		"oversized memory": strings.Replace(valid, "$m=19456,t=2,p=1$", "$m=999999999,t=2,p=1$", 1),
	}

	for name, encoded := range tests {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("Verify panicked: %v", recovered)
				}
			}()

			match, needsRehash, err := Verify(encoded, "valid password")
			if !errors.Is(err, ErrInvalidEncoded) {
				t.Fatalf("expected ErrInvalidEncoded, got match=%v rehash=%v err=%v", match, needsRehash, err)
			}
		})
	}
}

func TestVerifyRejectsEmptyPassword(t *testing.T) {
	_, _, err := Verify(testEncoded("m=19456,t=2,p=1"), "")
	if !errors.Is(err, ErrInvalidPassword) {
		t.Fatalf("expected ErrInvalidPassword, got %v", err)
	}
}

func TestHashRejectsPasswordOver1024UTF8Bytes(t *testing.T) {
	_, err := Hash(strings.Repeat("a", 1025))
	if !errors.Is(err, ErrInvalidPassword) {
		t.Fatalf("expected ErrInvalidPassword, got %v", err)
	}
}

func TestVerifyRejectsPasswordOver1024UTF8Bytes(t *testing.T) {
	_, _, err := Verify(testEncoded("m=19456,t=2,p=1"), strings.Repeat("a", 1025))
	if !errors.Is(err, ErrInvalidPassword) {
		t.Fatalf("expected ErrInvalidPassword, got %v", err)
	}
}

func TestVerifyReportsRehashForDifferentParameters(t *testing.T) {
	match, needsRehash, err := Verify(testEncoded("m=32768,t=2,p=1"), "valid password")
	if err != nil {
		t.Fatal(err)
	}
	if match {
		t.Fatal("unexpected password match")
	}
	if !needsRehash {
		t.Fatal("expected parameter upgrade to require rehash")
	}
}

func TestConcurrentHashAndVerify(t *testing.T) {
	encoded, err := Hash("concurrent password")
	if err != nil {
		t.Fatal(err)
	}

	const workers = 4
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			match, needsRehash, err := Verify(encoded, "concurrent password")
			if err != nil || !match || needsRehash {
				t.Errorf("match=%v rehash=%v err=%v", match, needsRehash, err)
			}
		}()
	}
	wg.Wait()
}

func testEncoded(parameters string) string {
	salt := base64.RawStdEncoding.EncodeToString(make([]byte, 16))
	hash := base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	return "$argon2id$v=19$" + parameters + "$" + salt + "$" + hash
}
