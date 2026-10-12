#include "greet.h"
#include "config.h"

std::string greet(const std::string& who) {
    return std::string(HELLO_GREETING) + ", " + who;
}
