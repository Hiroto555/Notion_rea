import type { Request } from "../shared/types";
import type {
  ConflictDecisionAction,
  ConflictDecisionPreview,
  ConflictDecisionView,
} from "../shared/workspace-conflict-resolution";
import type { ConflictPreviewRequest } from "../shared/workspace-conflict-resolution";

export type ConflictDecisionUiState = {
  view: ConflictDecisionView | null;
  preview: ConflictDecisionPreview | null;
  busy: boolean;
  acknowledged: boolean;
  unknown: boolean;
  notice: string;
};
export const emptyConflictDecisionUi = (): ConflictDecisionUiState => ({
  view: null,
  preview: null,
  busy: false,
  acknowledged: false,
  unknown: false,
  notice: "",
});

/** No apply/quit IPC exists here. A sequence rejects old responses after a new
 * review, cancellation or unmount. Unknown confirmation is resolved by status,
 * never by silently creating a new selection. */
export class ConflictDecisionModel {
  private sequence = 0;
  private state = emptyConflictDecisionUi();
  constructor(
    private readonly request: <T>(request: Request) => Promise<T>,
    private readonly inputReady: () => boolean,
    private readonly changed: (state: ConflictDecisionUiState) => void,
  ) {}
  snapshot() {
    return { ...this.state };
  }
  private publish(patch: Partial<ConflictDecisionUiState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.snapshot());
  }
  invalidate() {
    this.sequence++;
  }
  acknowledge(value: boolean) {
    this.publish({ acknowledged: value });
  }

  async refresh(): Promise<void> {
    if (this.state.busy) return;
    const sequence = this.sequence;
    try {
      const view = await this.request<ConflictDecisionView>({
        type: "sync:conflictDecisionStatus",
      });
      if (sequence === this.sequence)
        this.publish({
          view,
          unknown: false,
          ...(this.state.unknown
            ? { notice: "予約状態を再確認しました。" }
            : {}),
        });
    } catch {
      if (sequence === this.sequence) this.publish({ view: null });
    }
  }

  async review(request: ConflictPreviewRequest): Promise<void> {
    if (
      !this.inputReady() ||
      this.state.unknown ||
      this.state.view?.canPreview !== true
    ) {
      this.publish({
        notice: "入力・保存・復旧記録と選択状態を確認してください。",
      });
      return;
    }
    const sequence = ++this.sequence;
    this.publish({
      preview: null,
      acknowledged: false,
      busy: true,
      notice: "",
    });
    try {
      const preview = await this.request<ConflictDecisionPreview>({
        type: "sync:conflictPreview",
        ...request,
      });
      if (sequence === this.sequence) this.publish({ preview, busy: false });
    } catch {
      if (sequence === this.sequence)
        this.publish({
          busy: false,
          notice:
            "候補が変わった可能性があります。候補を確認し直してください。",
        });
    }
  }

  discardPreview(): void {
    if (this.state.busy) return;
    this.sequence++;
    this.publish({ preview: null, acknowledged: false });
  }

  async confirm(): Promise<void> {
    const preview = this.state.preview;
    if (
      this.state.busy ||
      !preview ||
      !this.state.acknowledged ||
      this.state.unknown
    )
      return;
    if (!this.inputReady()) {
      this.publish({
        notice:
          "入力や保存が進行中です。確定・保存後に候補を確認し直してください。",
      });
      return;
    }
    const sequence = ++this.sequence;
    this.publish({ busy: true, notice: "" });
    try {
      const action = await this.request<ConflictDecisionAction>({
        type: "sync:conflictConfirm",
        previewId: preview.id,
      });
      if (sequence === this.sequence)
        this.publish({
          view: action.view,
          preview: null,
          acknowledged: false,
          busy: false,
          notice:
            action.result === "requested"
              ? "選択を準備しました。通常どおり終了すると安全条件を再確認し、次回起動時に適用します。"
              : "選択を準備できませんでした。候補と入力を確認し直してください。",
        });
    } catch {
      if (sequence === this.sequence)
        this.publish({
          preview: null,
          busy: false,
          unknown: true,
          notice:
            "選択要求の結果を確認できません。状態を確認し、新しい選択を作らずに予約を確認・取消ししてください。",
        });
    }
  }

  async cancel(): Promise<void> {
    const id = this.state.view?.decisionId;
    if (!id || this.state.busy) return;
    const sequence = ++this.sequence;
    this.publish({
      busy: true,
      preview: null,
      acknowledged: false,
      notice: "",
    });
    try {
      const action = await this.request<ConflictDecisionAction>({
        type: "sync:conflictCancel",
        decisionId: id,
      });
      if (sequence === this.sequence)
        this.publish({
          view: action.view,
          busy: false,
          unknown: false,
          notice:
            action.result === "cancelled"
              ? "競合の選択予約を取り消しました。"
              : "取消し結果を確認してください。",
        });
    } catch {
      if (sequence === this.sequence)
        this.publish({
          busy: false,
          unknown: true,
          notice: "取消し結果を確認できません。状態を確認してください。",
        });
    }
  }
}
