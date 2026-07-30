class ContentEngineError(Exception):
    """An expected error safe to return across the desktop IPC boundary."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
