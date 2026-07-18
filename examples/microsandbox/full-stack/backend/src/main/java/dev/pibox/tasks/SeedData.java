package dev.pibox.tasks;

import io.quarkus.runtime.StartupEvent;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;
import jakarta.transaction.Transactional;

@ApplicationScoped
public class SeedData {
    @Transactional
    void onStart(@Observes StartupEvent event) {
        if (Task.count() > 0) {
            return;
        }

        Task first = new Task();
        first.title = "Connect TanStack Start to Quarkus";
        first.persist();

        Task second = new Task();
        second.title = "Persist tasks in PostgreSQL";
        second.completed = true;
        second.persist();
    }
}
