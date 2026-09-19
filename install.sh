#!/usr/bin/env bash

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# Register this repo as a local Pi package so Pi loads its skills/ and extensions/ directories from here.
pi install "$REPO_DIR"

# Symlink for other harnesses as well
mkdir -p "$HOME/.agents"
mkdir -p "$HOME/.claude"

ln -sfn "$REPO_DIR/skills" "$HOME/.agents/skills"
ln -sfn "$REPO_DIR/skills" "$HOME/.claude/skills"
