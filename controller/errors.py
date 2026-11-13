"""Shared controller refusal, re-exported by controller.core."""


class Refused(Exception):
    pass


RESTORE_REQUIRED = ("restore required: the controller's journal holds batches this database "
                    "doesn't, or a restore hasn't finished replaying and reconciling them; "
                    "run restore")
