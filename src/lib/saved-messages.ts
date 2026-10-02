import type { SavedChangeResult } from './saved-controller'

export const SAVED_CHANGE_HELP: Record<Extract<SavedChangeResult, { accepted: false }>['reason'], string> = {
  loading: '저장한 기록을 먼저 확인하고 있어요. 저장소 상태를 확인해 주세요.',
  limit: '최대 500개까지 저장할 수 있어요. CSV로 내보낸 뒤 정리해 주세요.',
  unreadable: '이 공고의 기존 기록을 읽을 수 없어 원본을 그대로 보관했어요.',
  missing: '저장한 목록에서 이 공고를 찾지 못했어요. 다시 저장해 주세요.',
  busy: '파일을 반영하고 있어요. 완료된 뒤 다시 시도해 주세요.',
}
