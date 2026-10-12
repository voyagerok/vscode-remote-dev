#include <iostream>
#include "greet.h"

int main(int argc, char** argv) {
    std::cout << greet(argc > 1 ? argv[1] : "world") << std::endl;
    return 0;
}
