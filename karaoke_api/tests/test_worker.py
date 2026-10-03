"""Очередь: submit регистрирует задачу, фоновый поток поднимается и останавливается."""
import karaoke_api.worker as W


def test_submit_registers_queued_job():
    job = W.submit(title="X", audio="music/x.mp3")
    try:
        assert W.registry.get(job.id) is job
        assert job.state == "queued"
        assert job.title == "X"
    finally:
        W.registry._jobs.pop(job.id, None)
        assert W._queue.get_nowait() == job.id
        W._queue.task_done()


def test_start_stop_is_idempotent():
    W.start()
    thread = W._thread
    assert thread is not None and thread.is_alive()
    W.start()  # повторный вызов не плодит потоки
    assert W._thread is thread
    W.stop()
    assert W._thread is None
    W.stop()  # остановка без запущенного потока — no-op
