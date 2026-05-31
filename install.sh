#!/usr/bin/env bash

# Register this repo as a local Pi package so Pi loads its skills/ and extensions/ directories from here.
pi install "$PWD"

# Symlink this repo's skills into ~/.claude so Claude Code picks them up too.
mkdir -p "$HOME/.claude"
ln -sfn "$PWD/skills" "$HOME/.claude/skills"
