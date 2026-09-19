import { Board } from '../components/Board';
import { Header } from '../components/Header';

export function BoardPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Header title="Task Board" subtitle="Drag tasks between columns to update status" />
      <Board />
    </div>
  );
}
