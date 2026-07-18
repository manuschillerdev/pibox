package dev.pibox.tasks;

import io.quarkus.hibernate.orm.panache.PanacheEntity;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

@Entity
@Table(name = "tasks")
public class Task extends PanacheEntity {
    public String title;
    public boolean completed;
}
