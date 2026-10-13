"""Resource failures shared by orchestration and pure calculation boundaries."""


class ResultStorageFull(RuntimeError):
    """Saved results have reached the process's storage capacity."""
