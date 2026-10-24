import { validator } from "hono/validator";
import { z } from "zod";
import HTTP from "@vicstack/http";

const ID_PATTERN = /^\d+$/;

export const idParamValidator = validator("param", (value, c) => {
  const id = value["id"];

  if (!id || !ID_PATTERN.test(id))
    return c.json(
      {
        error: {
          id: {
            errors: ["Expected number but received a string."],
          },
        },
        message: "Invalid param",
      },
      HTTP.BadRequest,
    );
  return {
    id: Number(id),
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
        HTTP.UnprocessableEntity,
      );
    return data;
  });
