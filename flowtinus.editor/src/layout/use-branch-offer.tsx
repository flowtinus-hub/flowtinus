import { useState, type ReactNode } from 'react';
import { getCurrentBranch } from '@/data/git/git-api';
import { useResource } from '@/data/use-resource';
import { useMe, useWorkspace } from '@/data/workspaces/use-workspace';
import type { ApiResult } from '@/lib/api';
import { CreateBranchDialog, type OfferedEdit } from './create-branch-dialog';

export type BranchOffer = {
    offers: boolean;
    offer: (edit: OfferedEdit, onCancel?: () => void) => void;
    orOffer: <T>(
        name: string,
        here: () => Promise<ApiResult<T>>,
        there?: () => Promise<ApiResult<unknown>>,
    ) => Promise<ApiResult<T | null>>;
    dialog: ReactNode;
};

export function useBranchOffer(): BranchOffer {
    const { handle, canEdit } = useWorkspace();
    const { state: me } = useMe();
    const userHandle = me.status === 'ready' ? me.me.handle : null;
    const current = useResource(`current-branch:${handle}`, () => getCurrentBranch(handle));
    const branch = current.state.status === 'ready' ? current.state.value : null;
    const offers = Boolean(branch?.offersBranch && branch.branch) && canEdit && userHandle !== null;
    const [offered, setOffered] = useState<{ edit: OfferedEdit; onCancel?: () => void } | null>(null);

    const offer = (edit: OfferedEdit, onCancel?: () => void) => setOffered({ edit, onCancel });
    const orOffer = async <T,>(name: string, here: () => Promise<ApiResult<T>>, there?: () => Promise<ApiResult<unknown>>) => {
        if (!offers) {
            return here();
        }
        offer({ name, replay: there ?? here });
        return { ok: true as const, value: null };
    };

    const dialog =
        offered && branch?.branch && userHandle ? (
            <CreateBranchDialog
                handle={handle}
                from={branch.branch}
                userHandle={userHandle}
                edit={offered.edit}
                onClose={() => {
                    offered.onCancel?.();
                    setOffered(null);
                }}
            />
        ) : null;

    return { offers, offer, orOffer, dialog };
}
