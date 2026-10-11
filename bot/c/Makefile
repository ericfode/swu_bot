# c-clock: Star Wars Unlimited bot over the stdio protocol (spec/stdio-protocol.md). No dependencies beyond libc.
CC ?= cc
CFLAGS ?= -O2 -std=gnu11 -Wall -Wextra -Wshadow -Wno-unused-parameter
OBJ = bot.o cards.o json.o

swu-c: $(OBJ)
	$(CC) $(CFLAGS) -o $@ $(OBJ) -lm

%.o: %.c cards.h json.h
	$(CC) $(CFLAGS) -c $<

clean:
	rm -f swu-c $(OBJ)

.PHONY: clean
