# CS732 project - Team Shinobi

Shinobi is a student social/directory project with a Node backend and a FastAPI recommendation service.

Your team members are:
- Htin Kyaw Soe Win _(hsoe085@aucklanduni.ac.nz)_
- Sa Bai Aung _(saun246@aucklanduni.ac.nz)_
- Yan Hmue Aung _(yaun499@aucklanduni.ac.nz)_
- Nan Win Pa Pa Htoon _(nhto131@aucklanduni.ac.nz)_
- Naing Khant _(nkha754@aucklanduni.ac.nz)_
- Eng Leang Sam _(esam570@aucklanduni.ac.nz)_
- Victor Xia _(vxia400@aucklanduni.ac.nz)_

## Central Docker Stack

Use the centralized Docker Compose file in `docker/` for local development. It runs:

- backend API: `http://localhost:8080`
- recommendation API: `http://localhost:8000`
- recommendation API docs: `http://localhost:8000/docs`
- MongoDB replica set: `mongodb://localhost:27017`
- Kafka broker: `localhost:9092`
- Neo4j Browser: `http://localhost:7474`
- Neo4j Bolt: `bolt://localhost:7687`

Start everything from the repo root:

```bash
docker compose -f docker/docker-compose.yml up --build
```

Run it in the background:

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

Stop the stack without deleting data:

```bash
docker compose -f docker/docker-compose.yml down
```

Reset all local Docker data and rerun the seed/bootstrap scripts:

```bash
docker compose -f docker/docker-compose.yml down -v
docker compose -f docker/docker-compose.yml up --build
```

## Environment

The compose file has development defaults. To customize host ports, passwords, or API keys:

```bash
cp docker/.env.example docker/.env
docker compose --env-file docker/.env -f docker/docker-compose.yml up --build
```

The shared MongoDB service is configured as a single-node replica set because the backend uses MongoDB change streams. The recommendation Mongo bootstrap scripts run against the same MongoDB container and create the `recommendation` database/user on first startup of a fresh volume.

## Service Folders

- `backend/` - Node/Express/Mongoose backend and MongoDB CDC listener
- `recommendation/` - FastAPI recommendation engine and Neo4j seed data
- `docker/` - canonical local Docker Compose stack shared by both services

![](./Shinobi.png)
