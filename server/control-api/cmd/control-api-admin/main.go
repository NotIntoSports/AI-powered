package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/ai-interviewer/ai-powered/control-api/internal/config"
	"github.com/ai-interviewer/ai-powered/control-api/internal/database"
	"github.com/ai-interviewer/ai-powered/control-api/internal/identity"
	"github.com/ai-interviewer/ai-powered/control-api/internal/users"
	"golang.org/x/term"
)

var (
	errInvalidCommand   = errors.New("invalid administrator command")
	errUnknownFlag      = errors.New("unknown flag")
	errUsernameRequired = errors.New("username is required")
	errPasswordRequired = errors.New("password is required")
	errPasswordMismatch = errors.New("password confirmation does not match")
	errPasswordInput    = errors.New("could not read password")
)

const (
	commandCreate        = "create"
	commandResetPassword = "reset-password"
	maxPasswordInput     = 1025
)

type executorFunc func(context.Context, string, string, string) (users.User, error)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	return runWithExecutor(args, stdin, stdout, executeAdminCommand)
}

func runWithExecutor(args []string, stdin io.Reader, stdout io.Writer, execute executorFunc) error {
	command, username, err := parseCommand(args)
	if err != nil {
		return err
	}
	plainPassword, err := readConfirmedPassword(stdin, stdout)
	if err != nil {
		return err
	}

	user, err := execute(context.Background(), command, username, plainPassword)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "%s %s\n", user.Username, user.ID)
	return err
}

func parseCommand(args []string) (string, string, error) {
	if len(args) < 2 || args[0] != "admin" || (args[1] != commandCreate && args[1] != commandResetPassword) {
		return "", "", errInvalidCommand
	}

	flags := flag.NewFlagSet("admin "+args[1], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	username := flags.String("username", "", "administrator username")
	if err := flags.Parse(args[2:]); err != nil {
		if strings.Contains(err.Error(), "flag provided but not defined") {
			return "", "", errUnknownFlag
		}
		return "", "", errInvalidCommand
	}
	if flags.NArg() != 0 {
		return "", "", errInvalidCommand
	}
	if strings.TrimSpace(*username) == "" {
		return "", "", errUsernameRequired
	}
	return args[1], *username, nil
}

func readConfirmedPassword(stdin io.Reader, stdout io.Writer) (string, error) {
	first, second, err := readPasswordPair(stdin, stdout)
	if err != nil {
		return "", errPasswordInput
	}
	if first == "" {
		return "", errPasswordRequired
	}
	if first != second {
		return "", errPasswordMismatch
	}
	return first, nil
}

func readPasswordPair(stdin io.Reader, stdout io.Writer) (string, string, error) {
	return readPasswordPairWithTerminal(stdin, stdout, term.IsTerminal, term.ReadPassword)
}

func readPasswordPairWithTerminal(
	stdin io.Reader,
	stdout io.Writer,
	isTerminal func(int) bool,
	readPassword func(int) ([]byte, error),
) (string, string, error) {
	if descriptor, ok := stdin.(interface{ Fd() uintptr }); ok && isTerminal(int(descriptor.Fd())) {
		if _, err := io.WriteString(stdout, "Password: "); err != nil {
			return "", "", err
		}
		firstBytes, err := readPassword(int(descriptor.Fd()))
		if _, writeErr := io.WriteString(stdout, "\nConfirm password: "); err == nil && writeErr != nil {
			err = writeErr
		}
		if err != nil {
			clear(firstBytes)
			return "", "", err
		}
		secondBytes, secondErr := readPassword(int(descriptor.Fd()))
		_, newlineErr := io.WriteString(stdout, "\n")
		first := string(firstBytes)
		second := string(secondBytes)
		clear(firstBytes)
		clear(secondBytes)
		if secondErr != nil {
			return "", "", secondErr
		}
		if newlineErr != nil {
			return "", "", newlineErr
		}
		return first, second, nil
	}

	scanner := bufio.NewScanner(stdin)
	scanner.Buffer(make([]byte, 256), maxPasswordInput)
	if !scanner.Scan() {
		return "", "", scannerError(scanner)
	}
	first := scanner.Text()
	if !scanner.Scan() {
		return "", "", scannerError(scanner)
	}
	return first, scanner.Text(), nil
}

func scannerError(scanner *bufio.Scanner) error {
	if err := scanner.Err(); err != nil {
		return err
	}
	return io.ErrUnexpectedEOF
}

func executeAdminCommand(ctx context.Context, command, username, plainPassword string) (users.User, error) {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return users.User{}, err
	}
	pool, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return users.User{}, err
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool); err != nil {
		return users.User{}, err
	}

	service := identity.NewService(pool)
	switch command {
	case commandCreate:
		return service.CreateInitialAdmin(ctx, username, plainPassword)
	case commandResetPassword:
		admin, err := users.NewStore(pool).GetByNormalizedUsername(ctx, username)
		if err != nil {
			return users.User{}, err
		}
		if err := service.ResetPassword(ctx, admin.User, admin.ID, plainPassword); err != nil {
			return users.User{}, err
		}
		return admin.User, nil
	default:
		return users.User{}, errInvalidCommand
	}
}
