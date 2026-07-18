import { createServerFn } from '@tanstack/react-start'

export interface Task {
  id: number
  title: string
  completed: boolean
}

const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:8080'

export const listTasks = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Task[]> => {
    const response = await fetch(`${backendUrl}/api/tasks`)
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`)
    }
    return (await response.json()) as Task[]
  },
)

export const createTask = createServerFn({ method: 'POST' })
  .validator((title: string) => {
    const value = title.trim()
    if (!value) throw new Error('Task title is required')
    return value
  })
  .handler(async ({ data }): Promise<Task> => {
    const response = await fetch(`${backendUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: data }),
    })
    if (!response.ok) {
      throw new Error(`Backend returned ${response.status}`)
    }
    return (await response.json()) as Task
  })
