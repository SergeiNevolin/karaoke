// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Upload from './Upload'

const mocks = vi.hoisted(() => ({
  uploadSong: vi.fn(),
  getJob: vi.fn(),
  fetchGeniusLines: vi.fn(),
}))

vi.mock('../lib/api', () => mocks)

const FILE = new File(['x'], 'song.mp3', { type: 'audio/mp3' })

beforeEach(() => {
  sessionStorage.clear()
  mocks.uploadSong.mockReset()
  mocks.getJob.mockReset()
  mocks.fetchGeniusLines.mockReset()
})

afterEach(() => {
  cleanup()
})

function pickFile() {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [FILE] } })
}

describe('Upload: песня не загрузилась', () => {
  it('сбой загрузки: понятная ошибка, «повторить» перезапускает одним кликом', async () => {
    mocks.uploadSong
      .mockRejectedValueOnce(new Error('Файл больше 1024 МБ'))
      .mockRejectedValueOnce(new Error('Нет связи с сервером — проверьте подключение и попробуйте снова'))
    render(<Upload onClose={() => {}} onDone={() => {}} />)
    pickFile()
    fireEvent.click(screen.getByText('Сделать караоке'))

    expect(await screen.findByText('Не удалось загрузить файл')).toBeInTheDocument()
    expect(screen.getByText('Файл больше 1024 МБ')).toBeInTheDocument()
    expect(sessionStorage.getItem('karaoke:uploadJob')).toBeNull()

    fireEvent.click(screen.getByText('Повторить загрузку'))
    expect(await screen.findByText('Нет связи с сервером — проверьте подключение и попробуйте снова')).toBeInTheDocument()
    expect(mocks.uploadSong).toHaveBeenCalledTimes(2)
  })

  it('«выбрать другой файл» возвращает к форме, а не в мёртвый экран', async () => {
    mocks.uploadSong.mockRejectedValueOnce(new Error('bad'))
    render(<Upload onClose={() => {}} onDone={() => {}} />)
    pickFile()
    fireEvent.click(screen.getByText('Сделать караоке'))
    expect(await screen.findByText('Не удалось загрузить файл')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Выбрать другой файл'))
    expect(screen.getByText('Сделать караоке')).toBeInTheDocument()
    expect(screen.getByText(/song\.mp3/)).toBeInTheDocument()
  })

  it('задача упала: причина из job.error и ключ возобновления убран', async () => {
    sessionStorage.setItem('karaoke:uploadJob', 'j9')
    mocks.getJob.mockResolvedValue({
      id: 'j9',
      state: 'error',
      stage: 'error',
      stageLabel: 'Ошибка',
      progress: 40,
      error: 'GPU упал',
    })
    render(<Upload onClose={() => {}} onDone={() => {}} />)

    expect(await screen.findByText('Песня не обработалась')).toBeInTheDocument()
    expect(screen.getByText('GPU упал')).toBeInTheDocument()
    expect(sessionStorage.getItem('karaoke:uploadJob')).toBeNull()
  })

  it('задача исчезла (404): ключ убран, предлагаем загрузить заново', async () => {
    sessionStorage.setItem('karaoke:uploadJob', 'j9')
    mocks.getJob.mockResolvedValue(null)
    render(<Upload onClose={() => {}} onDone={() => {}} />)

    expect(await screen.findByText('Задача не найдена')).toBeInTheDocument()
    expect(screen.getByText(/загрузите файл заново/)).toBeInTheDocument()
    expect(sessionStorage.getItem('karaoke:uploadJob')).toBeNull()
  })
})
