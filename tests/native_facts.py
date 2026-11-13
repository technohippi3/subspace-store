"""Public-shaped native recording facts shared by controller fixtures."""


def local_pipeline(root):
    if root is None:
        return dict(root=None, txid=None, has_pending=False, staged_count=0, commitment_idx=None,
                    steps={key: "pending" for key in ("local", "proving", "broadcast", "confirmed", "finalized", "published")}, pending_proofs=0)
    return dict(root=root, txid=None, has_pending=True, staged_count=0, commitment_idx=0,
                steps=dict(local="complete", proving="skipped", broadcast="in_progress",
                           confirmed="pending", finalized="pending", published="pending"), pending_proofs=0)


def committed_handle(name, root, script):
    return dict(name=name, commitment_root=root, commitment_idx=0, script_pubkey=script,
                status="committed", parked=False, publish_status=None)
