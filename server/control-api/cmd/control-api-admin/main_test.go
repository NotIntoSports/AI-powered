package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
)

func TestCreateDoesNotAcceptPasswordFlag(t *testing.T) {
	err := run([]string{"admin", "create", "--username", "owner", "--password", "leak"}, strings.NewReader(""), io.Discard)
	if !errors.Is(err, errUnknownFlag) {
		t.Fatalf("got %v", err)
	}
}

func TestEmptyAndMismatchedPasswordsFailBeforeDatabaseAccess(t *testing.T) {
	for name, input := range map[string]string{
		"empty":      "\n\n",
		"mismatched": "first password value\nsecond password value\n",
	} {
		t.Run(name, func(t *testing.T) {
			calls := 0
			execute := func(context.Context, string, string, string) (users.User, error) {
				calls++
				return users.User{}, nil
			}
			err := runWithExecutor([]string{"admin", "create", "--username", "owner"}, strings.NewReader(input), io.Discard, execute)
			if err == nil {
				t.Fatal("error = nil")
			}
			if calls != 0 {
				t.Fatalf("database executor called %d times", calls)
			}
		})
	}
}

func TestCreateOutputNeverContainsPassword(t *testing.T) {
	const suppliedPassword = "never print this password"
	var output strings.Builder
	execute := func(_ context.Context, command, username, password string) (users.User, error) {
		if command != commandCreate || username != "owner" || password != suppliedPassword {
			t.Fatalf("executor command=%q username=%q password=%q", command, username, password)
		}
		return users.User{ID: "admin-id", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}, nil
	}

	err := runWithExecutor(
		[]string{"admin", "create", "--username", "owner"},
		strings.NewReader(suppliedPassword+"\n"+suppliedPassword+"\n"),
		&output,
		execute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), suppliedPassword) {
		t.Fatalf("output exposed password: %q", output.String())
	}
	if output.String() != "owner admin-id\n" {
		t.Fatalf("output = %q, want only username and ID", output.String())
	}
}

func TestResetPasswordUsesSameProtectedInputPath(t *testing.T) {
	const suppliedPassword = "replacement password value"
	var output strings.Builder
	execute := func(_ context.Context, command, username, password string) (users.User, error) {
		if command != commandResetPassword || username != "owner" || password != suppliedPassword {
			t.Fatalf("executor command=%q username=%q password=%q", command, username, password)
		}
		return users.User{ID: "admin-id", Username: "owner", Role: users.RoleAdmin, Status: users.StatusActive}, nil
	}

	err := runWithExecutor(
		[]string{"admin", "reset-password", "--username", "owner"},
		strings.NewReader(suppliedPassword+"\n"+suppliedPassword+"\n"),
		&output,
		execute,
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), suppliedPassword) || output.String() != "owner admin-id\n" {
		t.Fatalf("output = %q", output.String())
	}
}

func TestTerminalPasswordInputUsesNoEchoReaderTwice(t *testing.T) {
	reader := fdReader{Reader: strings.NewReader("must not be read")}
	passwords := [][]byte{[]byte("terminal password value"), []byte("terminal password value")}
	readCalls := 0
	var output strings.Builder

	first, second, err := readPasswordPairWithTerminal(
		reader,
		&output,
		func(fd int) bool { return fd == 42 },
		func(fd int) ([]byte, error) {
			if fd != 42 {
				t.Fatalf("terminal fd = %d", fd)
			}
			value := passwords[readCalls]
			readCalls++
			return value, nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if first != "terminal password value" || second != first || readCalls != 2 {
		t.Fatalf("first=%q second=%q calls=%d", first, second, readCalls)
	}
	if strings.Contains(output.String(), first) {
		t.Fatalf("terminal output exposed password: %q", output.String())
	}
}

func TestUnknownCommandsAndMissingUsernameFailBeforePasswordRead(t *testing.T) {
	for _, args := range [][]string{
		{"user", "create", "--username", "owner"},
		{"admin", "delete", "--username", "owner"},
		{"admin", "create"},
	} {
		err := runWithExecutor(args, panicReader{}, io.Discard, func(context.Context, string, string, string) (users.User, error) {
			t.Fatal("executor called")
			return users.User{}, nil
		})
		if err == nil {
			t.Fatalf("args %q error = nil", args)
		}
	}
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) {
	panic("password input was read")
}

type fdReader struct {
	io.Reader
}

func (fdReader) Fd() uintptr { return 42 }
