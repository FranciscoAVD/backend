import { addTodo } from "@backend/f/todo/use-cases/add";
import { getTodo, getAllTodos } from "@backend/f/todo/use-cases/get";
import { updateTodo } from "@backend/f/todo/use-cases/update";
import { deleteTodo } from "@backend/f/todo/use-cases/delete";

export const todoRepo = {
  add: addTodo,
  get: {
    one: getTodo,
    all: getAllTodos,
  },
  update: updateTodo,
  delete: deleteTodo,
};
