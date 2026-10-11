import { addTodo } from "@f/todo/use-cases/add";
import { getTodo, getAllTodos } from "@f/todo/use-cases/get";
import { updateTodo } from "@f/todo/use-cases/update";
import { deleteTodo } from "@f/todo/use-cases/remove";

export const todoRepo = {
  add: addTodo,
  get: {
    one: getTodo,
    all: getAllTodos,
  },
  update: updateTodo,
  delete: deleteTodo,
};
