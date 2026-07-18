import { createFileRoute, useRouter } from '@tanstack/react-router'
import { type FormEvent, useState } from 'react'
import { createTask, listTasks } from '../tasks.functions'

export const Route = createFileRoute('/')({
  loader: () => listTasks(),
  component: Home,
})

function Home() {
  const tasks = Route.useLoaderData()
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    try {
      await createTask({ data: title })
      setTitle('')
      await router.invalidate()
    } finally {
      setPending(false)
    }
  }

  return (
    <main>
      <header>
        <p className="eyebrow">Pibox full stack</p>
        <h1>Tasks</h1>
        <p>TanStack Start → Quarkus → PostgreSQL</p>
      </header>

      <section className="panel">
        <form onSubmit={submit}>
          <input
            aria-label="Task title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a task"
            value={title}
          />
          <button disabled={pending || !title.trim()} type="submit">
            {pending ? 'Adding…' : 'Add task'}
          </button>
        </form>

        <ul>
          {tasks.map((task) => (
            <li key={task.id}>
              <span className={task.completed ? 'done' : undefined}>{task.title}</span>
              <small>{task.completed ? 'done' : 'open'}</small>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
