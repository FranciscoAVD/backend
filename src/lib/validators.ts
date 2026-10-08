import { validator } from "hono/validator";
import { z } from "zod";
import { HTTP_STATUS } from "@/lib/http-status";

export const idParamValidator = validator("param", (value, c) => {
  const id = value["id"];

  if (!id || !Number.isInteger(parseInt(id ?? "")))
    return c.json(
      {
        error: {
          id: {
            errors: ["Expected number but received a string."],
          },
        },
        message: "Invalid param",
      },
      HTTP_STATUS.BAD_REQUEST,
    );
  return {
    id: parseInt(id),
  };
});

export const jsonValidator = <T extends z.ZodObject>(schema: T) =>
  validator("json", (value, c) => {
    const { success, data, error } = schema.safeParse(value);
    if (!success)
      return c.json(
        {
          error: z.treeifyError(error).properties,
          message: "Failed to parse",
        },
        HTTP_STATUS.UNPROCESSABLE_ENTITY,
      );
    return {
      data,
    };
  });
