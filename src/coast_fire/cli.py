from __future__ import annotations

import argparse
import logging
import tomllib
from pathlib import Path

from .acquire import acquire
from .analysis import analyze


def main():
    parser = argparse.ArgumentParser(description="Build coastal fire station coverage data")
    parser.add_argument("--config", type=Path, default=Path("config/mendocino.toml"))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--output-dir", type=Path, default=Path("output"))
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("fetch", "analyze", "run"):
        command = commands.add_parser(name)
        if name != "analyze":
            command.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    config = tomllib.loads(args.config.read_text())
    if args.command in ("fetch", "run"):
        acquire(config, args.data_dir, args.refresh)
    if args.command in ("analyze", "run"):
        analyze(config, args.data_dir, args.output_dir)


if __name__ == "__main__":
    main()
