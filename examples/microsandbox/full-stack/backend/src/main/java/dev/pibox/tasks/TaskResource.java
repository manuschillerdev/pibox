package dev.pibox.tasks;

import jakarta.transaction.Transactional;
import jakarta.ws.rs.BadRequestException;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.util.List;

@Path("/api/tasks")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
public class TaskResource {
    @GET
    public List<Task> list() {
        return Task.list("order by id");
    }

    @POST
    @Transactional
    public Response create(CreateTask request) {
        if (request == null || request.title() == null || request.title().isBlank()) {
            throw new BadRequestException("title is required");
        }

        Task task = new Task();
        task.title = request.title().trim();
        task.persist();
        return Response.status(Response.Status.CREATED).entity(task).build();
    }

    public record CreateTask(String title) {}
}
