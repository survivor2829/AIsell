class ContentEngineError(Exception):
    """An expected error safe to return across the desktop IPC boundary.

    ``details`` holds measured values (caption ids, times, loudness) that explain
    the failure. They go to the local failure journal, not to the IPC reply.
    """

    def __init__(self, code: str, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}
