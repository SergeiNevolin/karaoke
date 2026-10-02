import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: string | null
}

/** последний рубеж: любая необработанная ошибка рендера — в плашку, а не в чёрный экран */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(e: unknown): State {
    return { error: e instanceof Error ? e.message : 'Неизвестная ошибка' }
  }

  componentDidCatch(e: unknown): void {
    console.error(e)
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="mx-auto grid h-full w-full max-w-3xl place-items-center px-5">
          <div className="w-full rounded-3xl border border-danger/20 bg-danger/10 p-7 text-center">
            <div className="text-lg font-semibold text-text">Что-то сломалось</div>
            <p className="mt-2 break-words text-[13px] text-muted">{this.state.error}</p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-5 rounded-2xl bg-surface-hover px-5 py-2.5 text-sm font-medium text-text transition hover:bg-border"
            >
              Попробовать снова
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
