"""The off-host journals, from `controller/journal.py`, under the harness's
old name. On a regtest run the off-host directory is
`.run/<run>/offhost/`, and a `<journal>.down` file there simulates an
outage."""

from controller.journal import Journal, JournalDown  # noqa: F401
