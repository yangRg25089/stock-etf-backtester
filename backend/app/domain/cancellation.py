"""Cooperative cancellation shared by pure calculation entry points."""


class RunCancelled(Exception):
    """The caller asked the current calculation to stop."""
