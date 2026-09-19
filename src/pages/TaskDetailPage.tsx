import { useParams } from 'react-router-dom';
import { Header } from '../components/Header';
import { TaskDetail } from '../components/TaskDetail';

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="flex-1 flex flex-col">
      <Header title="Task Detail" />
      {id && <TaskDetail taskId={id} />}
    </div>
  );
}
