FROM maven:3.9.9-eclipse-temurin-21 AS builder

WORKDIR /workspace
COPY pom.xml .
RUN mvn -q -DskipTests dependency:go-offline
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:21-jre-jammy

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/target/order-java-fault-0.0.1-SNAPSHOT.jar /app/order-java-fault.jar
EXPOSE 8082
ENTRYPOINT ["java", "-jar", "/app/order-java-fault.jar"]
